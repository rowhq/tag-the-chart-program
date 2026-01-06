#!/usr/bin/env ts-node
/**
 * Step 2: Create PDA's Associated Token Accounts (ATAs)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TagTheChartProgram } from "../target/types/tag_the_chart_program";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { fetchPoolAccounts } from "../tests/utils/pool-helper";
import * as dotenv from "dotenv";

dotenv.config();

// Pool address - update this for your target pool
const POOL_ADDRESS = new PublicKey(
  "RApKMv1ZXGcobQXjiAxs8CmDBvBpe6U2SGKuhrwkHXd"
);

async function main() {
  console.log("💳 Step 2: Creating PDA ATAs\n");

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

  // Fetch pool info
  console.log("\n⏳ Fetching pool accounts...");
  const poolAccounts = await fetchPoolAccounts(POOL_ADDRESS);
  console.log("✅ Pool fetched");
  console.log("  Token A:", poolAccounts.tokenMintA.toString());
  console.log("  Token B:", poolAccounts.tokenMintB.toString());

  // Derive PDA
  const [tradingAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("trading_account"), user.publicKey.toBuffer()],
    program.programId
  );
  console.log("\n📝 PDA:", tradingAccount.toString());

  // Get PDA ATAs
  const pdaAtaA = getAssociatedTokenAddressSync(
    poolAccounts.tokenMintA,
    tradingAccount,
    true
  );
  const pdaAtaB = getAssociatedTokenAddressSync(
    poolAccounts.tokenMintB,
    tradingAccount,
    true
  );

  console.log("\n💳 PDA ATAs to create:");
  console.log("  PDA Token A:", pdaAtaA.toString());
  console.log("  PDA Token B:", pdaAtaB.toString());

  // Create transaction
  const tx = new Transaction();
  const toCreate: string[] = [];

  const pdas = [
    [poolAccounts.tokenMintA, pdaAtaA, "PDA Token A"],
    [poolAccounts.tokenMintB, pdaAtaB, "PDA Token B"],
  ] as const;

  // Check and add PDA ATAs only
  for (const [mint, ata, name] of pdas) {
    try {
      await getAccount(connection, ata);
      console.log(`\n✅ ${name} ATA exists`);
    } catch {
      console.log(`\n⏳ Adding ${name} ATA to transaction`);
      tx.add(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          ata,
          tradingAccount,
          mint
        )
      );
      toCreate.push(name);
    }
  }

  // Send transaction
  if (tx.instructions.length === 0) {
    console.log("\n✅ All PDA ATAs already exist!");
    return;
  }

  console.log(`\n⏳ Creating ${toCreate.length} PDA ATAs...`);
  const sig = await provider.sendAndConfirm(tx);
  console.log("✅ PDA ATAs created!");
  console.log("📝 Signature:", sig);
  console.log(
    "🌐 Explorer:",
    `https://explorer.solana.com/tx/${sig}?cluster=devnet`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
// [dotenv@17.2.3] injecting env (0) from .env -- tip: 👥 sync secrets across teammates & machines: https://dotenvx.com/ops
// 💳 Step 2: Creating PDA ATAs

// ✅ Wallet: AANe5UL6nsobFf9SBdt9xtY6DTFiA6eutqZ1fMRqJ8He

// ⏳ Fetching pool accounts...
// ✅ Pool fetched
//   Token A: So11111111111111111111111111111111111111112
//   Token B: FncPdZa5MZr5dyxovcGFbZi1cL952HKBw95x2Wth9uX6

// 📝 PDA: 4Doxa8UyGtmhW3twMjLJYEijh7UnZ582huM7zbJ2G17K

// 💳 PDA ATAs to create:
//   PDA Token A: 4HLH1wqViJbZgJmh77A4BAEdpuUwZQsdAYkJWrhy9xSV
//   PDA Token B: 8M9SKT5mViy4KRxMZR92HeBBm1c8DAy4ggskWp7cue9F

// ⏳ Adding PDA Token A ATA to transaction

// ⏳ Adding PDA Token B ATA to transaction

// ⏳ Creating 2 PDA ATAs...
// ✅ PDA ATAs created!
// 📝 Signature: UxwHvaHuZ6mJGF9tixJRPKRmuk6oKttz8nDGb5xGHUd5Svgj3W2Dv7NYAX1FNqpiWhG3uN7eF7ptcGneYEtR2xQ
// 🌐 Explorer: https://explorer.solana.com/tx/UxwHvaHuZ6mJGF9tixJRPKRmuk6oKttz8nDGb5xGHUd5Svgj3W2Dv7NYAX1FNqpiWhG3uN7eF7ptcGneYEtR2xQ?cluster=devnet
