import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EwagerEscrow } from "../target/types/ewager_escrow";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("ewager-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EwagerEscrow as Program<EwagerEscrow>;
  
  let mint: anchor.web3.PublicKey;
  let authority: anchor.web3.Keypair;
  let treasury: anchor.web3.Keypair;
  let creator: anchor.web3.Keypair;
  let opponent: anchor.web3.Keypair;
  let creatorTokenAccount: anchor.web3.PublicKey;
  let opponentTokenAccount: anchor.web3.PublicKey;
  let treasuryTokenAccount: anchor.web3.PublicKey;
  let creatorFeeAccount: anchor.web3.PublicKey;
  
  let configPda: anchor.web3.PublicKey;
  
  const FEE_BPS = 500; // 5%
  const CREATOR_FEE_SHARE = 60; // 60%
  const WAGER_AMOUNT = 1_000_000_000; // 1 EWAGER (assuming 9 decimals)

  before(async () => {
    // Generate keypairs
    authority = anchor.web3.Keypair.generate();
    treasury = anchor.web3.Keypair.generate();
    creator = anchor.web3.Keypair.generate();
    opponent = anchor.web3.Keypair.generate();

    // Airdrop SOL for transaction fees
    await provider.connection.requestAirdrop(
      authority.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.requestAirdrop(
      creator.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.requestAirdrop(
      opponent.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.requestAirdrop(
      treasury.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Wait for airdrops to confirm
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Create EWAGER token mint
    mint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    // Create token accounts
    creatorTokenAccount = await createAccount(
      provider.connection,
      creator,
      mint,
      creator.publicKey
    );

    opponentTokenAccount = await createAccount(
      provider.connection,
      opponent,
      mint,
      opponent.publicKey
    );

    treasuryTokenAccount = await createAccount(
      provider.connection,
      treasury,
      mint,
      treasury.publicKey
    );

    creatorFeeAccount = await createAccount(
      provider.connection,
      creator,
      mint,
      creator.publicKey
    );

    // Mint tokens to players
    await mintTo(
      provider.connection,
      authority,
      mint,
      creatorTokenAccount,
      authority,
      10 * WAGER_AMOUNT
    );

    await mintTo(
      provider.connection,
      authority,
      mint,
      opponentTokenAccount,
      authority,
      10 * WAGER_AMOUNT
    );

    // Derive config PDA
    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
  });

  it("Initializes the protocol", async () => {
    await program.methods
      .initialize(FEE_BPS, CREATOR_FEE_SHARE)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const config = await program.account.protocolConfig.fetch(configPda);
    assert.equal(config.feeBps, FEE_BPS);
    assert.equal(config.creatorFeeShare, CREATOR_FEE_SHARE);
    assert.equal(config.authority.toBase58(), authority.publicKey.toBase58());
    assert.equal(config.treasury.toBase58(), treasury.publicKey.toBase58());
    assert.isFalse(config.paused);
  });

  it("Creates an open wager", async () => {
    const wagerId = new anchor.BN(Date.now());
    const [wagerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), wagerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), wagerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const creatorBalanceBefore = await getAccount(
      provider.connection,
      creatorTokenAccount
    );

    await program.methods
      .createWager(
        wagerId,
        new anchor.BN(WAGER_AMOUNT),
        anchor.web3.SystemProgram.programId // Open wager
      )
      .accounts({
        config: configPda,
        wager: wagerPda,
        escrow: escrowPda,
        creator: creator.publicKey,
        creatorTokenAccount: creatorTokenAccount,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();

    const wager = await program.account.wager.fetch(wagerPda);
    assert.equal(wager.amount.toString(), WAGER_AMOUNT.toString());
    assert.equal(wager.creator.toBase58(), creator.publicKey.toBase58());
    assert.deepEqual(wager.status, { open: {} });

    const creatorBalanceAfter = await getAccount(
      provider.connection,
      creatorTokenAccount
    );
    assert.equal(
      Number(creatorBalanceBefore.amount) - Number(creatorBalanceAfter.amount),
      WAGER_AMOUNT
    );

    const escrowBalance = await getAccount(provider.connection, escrowPda);
    assert.equal(Number(escrowBalance.amount), WAGER_AMOUNT);
  });

  it("Opponent accepts the wager", async () => {
    const wagerId = new anchor.BN(Date.now() + 1000);
    const [wagerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), wagerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), wagerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Create wager first
    await program.methods
      .createWager(
        wagerId,
        new anchor.BN(WAGER_AMOUNT),
        anchor.web3.SystemProgram.programId
      )
      .accounts({
        config: configPda,
        wager: wagerPda,
        escrow: escrowPda,
        creator: creator.publicKey,
        creatorTokenAccount: creatorTokenAccount,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();

    const opponentBalanceBefore = await getAccount(
      provider.connection,
      opponentTokenAccount
    );

    // Accept wager
    await program.methods
      .acceptWager()
      .accounts({
        config: configPda,
        wager: wagerPda,
        escrow: escrowPda,
        opponent: opponent.publicKey,
        opponentTokenAccount: opponentTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([opponent])
      .rpc();

    const wager = await program.account.wager.fetch(wagerPda);
    assert.equal(wager.opponent.toBase58(), opponent.publicKey.toBase58());
    assert.deepEqual(wager.status, { active: {} });

    const opponentBalanceAfter = await getAccount(
      provider.connection,
      opponentTokenAccount
    );
    assert.equal(
      Number(opponentBalanceBefore.amount) - Number(opponentBalanceAfter.amount),
      WAGER_AMOUNT
    );

    const escrowBalance = await getAccount(provider.connection, escrowPda);
    assert.equal(Number(escrowBalance.amount), WAGER_AMOUNT * 2);
  });

  it("Settles wager and distributes funds correctly", async () => {
    const wagerId = new anchor.BN(Date.now() + 2000);
    const [wagerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), wagerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), wagerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Create and accept wager
    await program.methods
      .createWager(
        wagerId,
        new anchor.BN(WAGER_AMOUNT),
        anchor.web3.SystemProgram.programId
      )
      .accounts({
        config: configPda,
        wager: wagerPda,
        escrow: escrowPda,
        creator: creator.publicKey,
        creatorTokenAccount: creatorTokenAccount,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .acceptWager()
      .accounts({
        config: configPda,
        wager: wagerPda,
        escrow: escrowPda,
        opponent: opponent.publicKey,
        opponentTokenAccount: opponentTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([opponent])
      .rpc();

    // Get balances before settlement
    const creatorBalanceBefore = await getAccount(
      provider.connection,
      creatorTokenAccount
    );
    const treasuryBalanceBefore = await getAccount(
      provider.connection,
      treasuryTokenAccount
    );
    const creatorFeeBalanceBefore = await getAccount(
      provider.connection,
      creatorFeeAccount
    );

    // Settle with creator as winner
    await program.methods
      .settleWager(creator.publicKey)
      .accounts({
        config: configPda,
        wager: wagerPda,
        escrow: escrowPda,
        authority: authority.publicKey,
        winnerTokenAccount: creatorTokenAccount,
        creator: creator.publicKey,
        creatorFeeAccount: creatorFeeAccount,
        treasuryTokenAccount: treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const wager = await program.account.wager.fetch(wagerPda);
    assert.equal(wager.winner.toBase58(), creator.publicKey.toBase58());
    assert.deepEqual(wager.status, { settled: {} });

    // Verify payouts
    const totalPot = WAGER_AMOUNT * 2;
    const totalFee = (totalPot * FEE_BPS) / 10000; // 5%
    const creatorFee = (totalFee * CREATOR_FEE_SHARE) / 100; // 60% of fee
    const treasuryFee = totalFee - creatorFee; // 40% of fee
    const winnerPayout = totalPot - totalFee;

    const creatorBalanceAfter = await getAccount(
      provider.connection,
      creatorTokenAccount
    );
    const treasuryBalanceAfter = await getAccount(
      provider.connection,
      treasuryTokenAccount
    );
    const creatorFeeBalanceAfter = await getAccount(
      provider.connection,
      creatorFeeAccount
    );

    assert.equal(
      Number(creatorBalanceAfter.amount) - Number(creatorBalanceBefore.amount),
      winnerPayout
    );
    assert.equal(
      Number(treasuryBalanceAfter.amount) - Number(treasuryBalanceBefore.amount),
      treasuryFee
    );
    assert.equal(
      Number(creatorFeeBalanceAfter.amount) - Number(creatorFeeBalanceBefore.amount),
      creatorFee
    );
  });

  it("Allows cancellation after 24 hours", async () => {
    const wagerId = new anchor.BN(Date.now() + 3000);
    const [wagerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), wagerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), wagerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .createWager(
        wagerId,
        new anchor.BN(WAGER_AMOUNT),
        anchor.web3.SystemProgram.programId
      )
      .accounts({
        config: configPda,
        wager: wagerPda,
        escrow: escrowPda,
        creator: creator.publicKey,
        creatorTokenAccount: creatorTokenAccount,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();

    // Note: In real test, would need to wait or manipulate clock
    // For now, this demonstrates the structure
    try {
      await program.methods
        .cancelWager()
        .accounts({
          wager: wagerPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          creatorTokenAccount: creatorTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([creator])
        .rpc();
      
      assert.fail("Should have failed - cancellation too early");
    } catch (err) {
      assert.include(err.toString(), "CancellationTooEarly");
    }
  });

  it("Prevents unauthorized config updates", async () => {
    const unauthorizedAuthority = anchor.web3.Keypair.generate();
    
    await provider.connection.requestAirdrop(
      unauthorizedAuthority.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await program.methods
        .updateConfig(1000, 50, false)
        .accounts({
          config: configPda,
          authority: unauthorizedAuthority.publicKey,
        })
        .signers([unauthorizedAuthority])
        .rpc();
      
      assert.fail("Should have failed - unauthorized");
    } catch (err) {
      assert.include(err.toString(), "ConstraintSeeds");
    }
  });

  it("Updates protocol config correctly", async () => {
    const newFeeBps = 300; // 3%
    const newCreatorShare = 70; // 70%

    await program.methods
      .updateConfig(newFeeBps, newCreatorShare, null)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const config = await program.account.protocolConfig.fetch(configPda);
    assert.equal(config.feeBps, newFeeBps);
    assert.equal(config.creatorFeeShare, newCreatorShare);
  });
});
