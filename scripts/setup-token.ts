import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
  AuthorityType,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

/**
 * EWAGER Token Setup Script
 * 
 * Creates the EWAGER SPL token with the following specifications:
 * - Fixed supply: 1,000,000,000 tokens
 * - Decimals: 9 (standard for Solana tokens)
 * - Mint authority: Revoked after initial supply creation
 * - Freeze authority: None (cannot freeze accounts)
 * 
 * Usage:
 * 1. Set RPC_URL environment variable
 * 2. Ensure keypair file exists at ~/.config/solana/id.json
 * 3. Run: ts-node setup-token.ts
 */

async function main() {
  const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(RPC_URL, "confirmed");

  // Load deployer keypair
  const keypairPath = path.join(
    process.env.HOME!,
    ".config",
    "solana",
    "id.json"
  );
  
  if (!fs.existsSync(keypairPath)) {
    throw new Error(
      `Keypair not found at ${keypairPath}. Run 'solana-keygen new' first.`
    );
  }

  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const deployer = Keypair.fromSecretKey(new Uint8Array(keypairData));

  console.log("=".repeat(60));
  console.log("EWAGER Token Setup");
  console.log("=".repeat(60));
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);

  // Check balance
  const balance = await connection.getBalance(deployer.publicKey);
  console.log(`Balance: ${balance / 1e9} SOL`);
  
  if (balance < 1e9) {
    throw new Error("Insufficient SOL for deployment. Need at least 1 SOL.");
  }

  console.log("\n" + "-".repeat(60));
  console.log("Step 1: Creating EWAGER mint");
  console.log("-".repeat(60));

  // Create the EWAGER token mint
  const mint = await createMint(
    connection,
    deployer,
    deployer.publicKey, // Initial mint authority
    null,               // No freeze authority (cannot freeze user accounts)
    9                   // 9 decimals (standard)
  );

  console.log(`✅ Mint created: ${mint.toBase58()}`);

  console.log("\n" + "-".repeat(60));
  console.log("Step 2: Creating deployer token account");
  console.log("-".repeat(60));

  // Create associated token account for deployer
  const deployerTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    deployer,
    mint,
    deployer.publicKey
  );

  console.log(`✅ Token account: ${deployerTokenAccount.address.toBase58()}`);

  console.log("\n" + "-".repeat(60));
  console.log("Step 3: Minting initial supply");
  console.log("-".repeat(60));

  // Mint 1 billion tokens (1,000,000,000 with 9 decimals)
  const TOTAL_SUPPLY = 1_000_000_000 * 10 ** 9;
  
  await mintTo(
    connection,
    deployer,
    mint,
    deployerTokenAccount.address,
    deployer,
    TOTAL_SUPPLY
  );

  console.log(`✅ Minted ${TOTAL_SUPPLY / 10 ** 9} EWAGER tokens`);

  console.log("\n" + "-".repeat(60));
  console.log("Step 4: Revoking mint authority (fixed supply)");
  console.log("-".repeat(60));

  // Revoke mint authority to make supply fixed
  await setAuthority(
    connection,
    deployer,
    mint,
    deployer,
    AuthorityType.MintTokens,
    null // Setting to null revokes the authority
  );

  console.log("✅ Mint authority revoked - supply is now fixed");

  console.log("\n" + "=".repeat(60));
  console.log("TOKEN SETUP COMPLETE");
  console.log("=".repeat(60));
  console.log(`Mint Address: ${mint.toBase58()}`);
  console.log(`Total Supply: ${TOTAL_SUPPLY / 10 ** 9} EWAGER`);
  console.log(`Decimals: 9`);
  console.log(`Mint Authority: Revoked ✓`);
  console.log(`Freeze Authority: None ✓`);
  console.log(`Deployer Balance: ${TOTAL_SUPPLY / 10 ** 9} EWAGER`);
  console.log("=".repeat(60));

  // Save mint address to file for easy reference
  const mintInfoPath = path.join(__dirname, "../.mint-address.json");
  fs.writeFileSync(
    mintInfoPath,
    JSON.stringify(
      {
        mint: mint.toBase58(),
        deployer: deployer.publicKey.toBase58(),
        supply: TOTAL_SUPPLY / 10 ** 9,
        decimals: 9,
        network: RPC_URL.includes("devnet") ? "devnet" : "mainnet",
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(`\n💾 Mint info saved to: ${mintInfoPath}`);
  console.log("\nNext steps:");
  console.log("1. Update Anchor.toml with this mint address");
  console.log("2. Deploy the escrow program: anchor deploy");
  console.log("3. Initialize the protocol: anchor run initialize");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Error:", err);
    process.exit(1);
  });
