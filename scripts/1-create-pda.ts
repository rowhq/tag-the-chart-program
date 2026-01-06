#!/usr/bin/env ts-node
/**
 * Step 1: Create PDA Trading Account
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TagTheChartProgram } from "../target/types/tag_the_chart_program";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("🏗️  Step 1: Creating PDA Trading Account\n");

  // Setup
  const secretKey = process.env.TOKEN_HOLDER_SECRET_KEY;
  if (!secretKey) throw new Error("❌ TOKEN_HOLDER_SECRET_KEY not set");

  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKey)));

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
  console.log("✅ Program:", program.programId.toString());

  // Derive PDA
  const [tradingAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("trading_account"), user.publicKey.toBuffer()],
    program.programId
  );

  console.log("\n📝 PDA Trading Account:", tradingAccount.toString());

  // Check if already exists
  try {
    await program.account.tradingAccount.fetch(tradingAccount);
    console.log("\n✅ PDA already exists!");
    return;
  } catch {
    console.log("\n⏳ Creating PDA...");
  }

  // Create PDA
  try {
    const tx = await program.methods
      .initialize()
      .accounts({
        user: user.publicKey,
      })
      .rpc();

    console.log("✅ PDA created!");
    console.log("📝 Signature:", tx);
    console.log(
      "🌐 Explorer:",
      `https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );
  } catch (error) {
    console.error("❌ Failed:", error);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// 🏗️  Step 1: Creating PDA Trading Account

// ✅ Wallet: AANe5UL6nsobFf9SBdt9xtY6DTFiA6eutqZ1fMRqJ8He
// ✅ Program: 47z6kVAxM8LxGqSgFHXyMq3eK4Lq2U7TQXLpV3bjPtdD

// 📝 PDA Trading Account: 4Doxa8UyGtmhW3twMjLJYEijh7UnZ582huM7zbJ2G17K

// ⏳ Creating PDA...
// ✅ PDA created!
// 📝 Signature: 4Nzwg377GKKbnCVeZEVzewArGVW8t3MLHKa8UUckNdEWqMnqWodiH1HLwWXvsttKnjNynNkEwZhteu236gdtJFR3
// 🌐 Explorer: https://explorer.solana.com/tx/4Nzwg377GKKbnCVeZEVzewArGVW8t3MLHKa8UUckNdEWqMnqWodiH1HLwWXvsttKnjNynNkEwZhteu236gdtJFR3?cluster=devnet
