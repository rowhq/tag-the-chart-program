#!/usr/bin/env ts-node
/**
 * Step 4: Transfer Tokens directly to PDA
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { TagTheChartProgram } from "../target/types/tag_the_chart_program";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { fetchPoolAccounts } from "../tests/utils/pool-helper";
import * as dotenv from "dotenv";

dotenv.config();

// Pool address
const POOL_ADDRESS = new PublicKey(
  "RApKMv1ZXGcobQXjiAxs8CmDBvBpe6U2SGKuhrwkHXd"
);

// Amount to deposit (will be multiplied by token decimals)
const TOKEN_AMOUNT = 100;

async function main() {
  console.log("🪙 Step 4: Transfer Tokens to PDA\n");

  // Setup
  const secretKey = process.env.TOKEN_HOLDER_SECRET_KEY;
  if (!secretKey) throw new Error("❌ TOKEN_HOLDER_SECRET_KEY not set");

  const user = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(secretKey))
  );

  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "processed"
  );
  const wallet = new anchor.Wallet(user);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "processed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace
    .TagTheChartProgram as Program<TagTheChartProgram>;

  console.log("✅ Wallet:", user.publicKey.toString());

  // Fetch pool info
  console.log("\n⏳ Fetching pool accounts...");
  const poolAccounts = await fetchPoolAccounts(POOL_ADDRESS);

  // Determine non-WSOL token
  const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  const isTokenAWsol = poolAccounts.tokenMintA.equals(WSOL_MINT);
  const tokenMint = isTokenAWsol ? poolAccounts.tokenMintB : poolAccounts.tokenMintA;

  console.log("✅ Token mint:", tokenMint.toString());

  // Derive PDA
  const [tradingAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("trading_account"), user.publicKey.toBuffer()],
    program.programId
  );

  // Get ATAs
  const userTokenAta = getAssociatedTokenAddressSync(tokenMint, user.publicKey);
  const pdaTokenAta = getAssociatedTokenAddressSync(
    tokenMint,
    tradingAccount,
    true
  );

  console.log("\n📝 User Token ATA:", userTokenAta.toString());
  console.log("📝 PDA Token ATA:", pdaTokenAta.toString());

  // Check user balance
  console.log("\n💰 Checking user token balance...");
  const userBalance = await connection.getTokenAccountBalance(userTokenAta);
  console.log(
    `  User balance: ${userBalance.value.uiAmount} tokens (${userBalance.value.decimals} decimals)`
  );

  if (!userBalance.value.uiAmount || userBalance.value.uiAmount < TOKEN_AMOUNT) {
    console.warn(
      `⚠️  Warning: User has insufficient balance (${userBalance.value.uiAmount} < ${TOKEN_AMOUNT})`
    );
    console.log("Skipping deposit...");
    return;
  }

  // Transfer tokens directly using SPL Token
  console.log(`\n⏳ Transferring ${TOKEN_AMOUNT} tokens to PDA...`);
  const transferAmount = TOKEN_AMOUNT * Math.pow(10, userBalance.value.decimals);

  try {
    const { createTransferCheckedInstruction } = await import(
      "@solana/spl-token"
    );
    const { Transaction } = await import("@solana/web3.js");

    const transferTx = new Transaction().add(
      createTransferCheckedInstruction(
        userTokenAta,
        tokenMint,
        pdaTokenAta,
        user.publicKey,
        transferAmount,
        userBalance.value.decimals
      )
    );

    const sig = await provider.sendAndConfirm(transferTx);

    console.log("✅ Tokens transferred to PDA!");
    console.log("📝 Signature:", sig);
    console.log(
      "🌐 Explorer:",
      `https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  } catch (error) {
    console.error("❌ Failed to transfer:", error);
    throw error;
  }

  // Check balance
  console.log("\n📊 Checking PDA balance...");
  const pdaBalance = await connection.getTokenAccountBalance(pdaTokenAta);
  console.log(`✅ PDA token balance: ${pdaBalance.value.uiAmount} tokens`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
