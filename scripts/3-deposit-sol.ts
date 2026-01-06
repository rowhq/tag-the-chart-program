#!/usr/bin/env ts-node
/**
 * Step 3: Wrap SOL directly to PDA
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { TagTheChartProgram } from "../target/types/tag_the_chart_program";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createSyncNativeInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

dotenv.config();

// Amount to wrap and deposit (in SOL)
const SOL_AMOUNT = 0.5;

async function main() {
  console.log("💰 Step 3: Wrap SOL to PDA\n");

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

  const [tradingAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("trading_account"), user.publicKey.toBuffer()],
    program.programId
  );

  // Get PDA WSOL ATA
  const pdaWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    tradingAccount,
    true
  );

  console.log("📝 PDA WSOL ATA:", pdaWsolAta.toString());

  // Wrap SOL directly to PDA's WSOL ATA
  console.log("\n⏳ Wrapping SOL directly to PDA...");
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: pdaWsolAta,
      lamports: SOL_AMOUNT * LAMPORTS_PER_SOL,
    }),
    createSyncNativeInstruction(pdaWsolAta)
  );

  const wrapSig = await provider.sendAndConfirm(wrapTx);
  console.log("✅ SOL wrapped directly to PDA!");
  console.log(`https://explorer.solana.com/tx/${wrapSig}?cluster=devnet`);

  // 3. Check balance
  console.log("\n📊 Checking PDA balance...");
  const balance = await connection.getTokenAccountBalance(pdaWsolAta);
  console.log(`✅ PDA WSOL balance: ${balance.value.uiAmount} WSOL`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
