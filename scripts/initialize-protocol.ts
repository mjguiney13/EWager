import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EwagerEscrow } from "../target/types/ewager_escrow";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

/**
 * Initialize EWager Protocol
 * 
 * Sets up the protocol configuration with:
 * - Protocol fee: 5% (500 basis points)
 * - Creator fee share: 60% of protocol fees
 * - Treasury fee share: 40% of protocol fees
 * 
 * Usage:
 * 1. Ensure escrow program is deployed
 * 2. Set TREASURY_PUBKEY environment variable (or uses deployer)
 * 3. Run: anchor run initialize
 */

async function main() {
  // Setup provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EwagerEscrow as Program<EwagerEscrow>;
  
  // Load deployer keypair (authority)
  const authority = provider.wallet as anchor.Wallet;
  
  console.log("=".repeat(60));
  console.log("EWAGER PROTOCOL INITIALIZATION");
  console.log("=".repeat(60));
  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(`Authority: ${authority.publicKey.toBase58()}`);
  console.log(`Network: ${provider.connection.rpcEndpoint}`);

  // Treasury can be set via env var, otherwise defaults to authority
  const treasuryPubkey = process.env.TREASURY_PUBKEY
    ? new PublicKey(process.env.TREASURY_PUBKEY)
    : authority.publicKey;

  console.log(`Treasury: ${treasuryPubkey.toBase58()}`);

  // Protocol parameters
  const FEE_BPS = 500;              // 5% total fee
  const CREATOR_FEE_SHARE = 60;     // 60% goes to creator, 40% to treasury

  console.log("\n" + "-".repeat(60));
  console.log("Protocol Parameters:");
  console.log("-".repeat(60));
  console.log(`Total Fee: ${FEE_BPS / 100}% of wager pot`);
  console.log(`Creator Share: ${CREATOR_FEE_SHARE}% of fees`);
  console.log(`Treasury Share: ${100 - CREATOR_FEE_SHARE}% of fees`);
  console.log("\nExample (100 EWAGER wager):");
  console.log(`  Total pot: 200 EWAGER`);
  console.log(`  Protocol fee: ${(200 * FEE_BPS) / 10000} EWAGER`);
  console.log(`  Creator receives: ${(200 * FEE_BPS * CREATOR_FEE_SHARE) / 1000000} EWAGER`);
  console.log(`  Treasury receives: ${(200 * FEE_BPS * (100 - CREATOR_FEE_SHARE)) / 1000000} EWAGER`);
  console.log(`  Winner receives: ${200 - (200 * FEE_BPS) / 10000} EWAGER`);

  // Derive config PDA
  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  console.log("\n" + "-".repeat(60));
  console.log("Derived Accounts:");
  console.log("-".repeat(60));
  console.log(`Config PDA: ${configPda.toBase58()}`);
  console.log(`Config Bump: ${configBump}`);

  // Check if already initialized
  try {
    const existingConfig = await program.account.protocolConfig.fetch(configPda);
    console.log("\n⚠️  Protocol already initialized!");
    console.log(`Current authority: ${existingConfig.authority.toBase58()}`);
    console.log(`Current treasury: ${existingConfig.treasury.toBase58()}`);
    console.log(`Current fee: ${existingConfig.feeBps / 100}%`);
    
    const readline = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      readline.question(
        "\nDo you want to update the config instead? (yes/no): ",
        resolve
      );
    });
    readline.close();

    if (answer.toLowerCase() === "yes") {
      console.log("\n" + "-".repeat(60));
      console.log("Updating protocol config...");
      console.log("-".repeat(60));

      const tx = await program.methods
        .updateConfig(FEE_BPS, CREATOR_FEE_SHARE, null)
        .accounts({
          config: configPda,
          authority: authority.publicKey,
        })
        .rpc();

      console.log(`✅ Config updated: ${tx}`);
    } else {
      console.log("Exiting without changes.");
    }
    
    return;
  } catch (err) {
    // Not initialized yet, proceed
  }

  console.log("\n" + "-".repeat(60));
  console.log("Initializing protocol...");
  console.log("-".repeat(60));

  const tx = await program.methods
    .initialize(FEE_BPS, CREATOR_FEE_SHARE)
    .accounts({
      config: configPda,
      authority: authority.publicKey,
      treasury: treasuryPubkey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(`✅ Transaction: ${tx}`);

  // Fetch and verify config
  const config = await program.account.protocolConfig.fetch(configPda);

  console.log("\n" + "=".repeat(60));
  console.log("PROTOCOL INITIALIZED SUCCESSFULLY");
  console.log("=".repeat(60));
  console.log(`Config PDA: ${configPda.toBase58()}`);
  console.log(`Authority: ${config.authority.toBase58()}`);
  console.log(`Treasury: ${config.treasury.toBase58()}`);
  console.log(`Fee: ${config.feeBps / 100}%`);
  console.log(`Creator Fee Share: ${config.creatorFeeShare}%`);
  console.log(`Paused: ${config.paused}`);
  console.log("=".repeat(60));

  // Save config info
  const configInfoPath = path.join(__dirname, "../.protocol-config.json");
  fs.writeFileSync(
    configInfoPath,
    JSON.stringify(
      {
        configPda: configPda.toBase58(),
        authority: config.authority.toBase58(),
        treasury: config.treasury.toBase58(),
        feeBps: config.feeBps,
        creatorFeeShare: config.creatorFeeShare,
        network: provider.connection.rpcEndpoint.includes("devnet")
          ? "devnet"
          : "mainnet",
        initializedAt: new Date().toISOString(),
        transactionSignature: tx,
      },
      null,
      2
    )
  );

  console.log(`\n💾 Config saved to: ${configInfoPath}`);
  console.log("\nNext steps:");
  console.log("1. Start the backend API server");
  console.log("2. Deploy the frontend");
  console.log("3. Create your first wager!");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Error:", err);
    process.exit(1);
  });
