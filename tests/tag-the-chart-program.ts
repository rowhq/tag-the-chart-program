import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { TagTheChartProgram } from "../target/types/tag_the_chart_program";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  syncNative,
  createSyncNativeInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { fetchPoolAccounts } from "./utils/pool-helper";
import { expect } from "chai";

import * as dotenv from "dotenv";

dotenv.config();

describe("tag-the-chart-program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .tagTheChartProgram as Program<TagTheChartProgram>;

  const user = provider.wallet as anchor.Wallet;

  // Raydium CLMM program ID
  const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
  );

  // Token Programs
  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );
  const TOKEN_2022_PROGRAM_ID = new PublicKey(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  );

  // SPL Memo program
  const MEMO_PROGRAM_ID = new PublicKey(
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
  );

  // Raydium CLMM pool address
  const POOL_ADDRESS = new PublicKey(
    "6A1PJ4HnmhX7KHHrBS9FvSLQoU7hzauB8hvFQtvrfGUi"
  );

  let tradingAccount: PublicKey;

  it("Initialize trading account", async () => {
    [tradingAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("trading_account"), user.publicKey.toBuffer()],
      program.programId
    );

    await program.methods.initialize().accounts({ user: user.publicKey }).rpc();
  });

  it("Deposit SOL to trading account", async () => {
    const depositAmount = new BN(0.1 * LAMPORTS_PER_SOL); // 0.1 SOL

    await program.methods
      .depositSol(depositAmount)
      .accounts({ user: user.publicKey })
      .rpc();

    const balance = await provider.connection.getBalance(tradingAccount);
    expect(balance).to.gt(0);
  });

  it("Swap to target prices with forked pool", async () => {
    const pool = await fetchPoolAccounts(POOL_ADDRESS);

    // Wrapped SOL mint address
    const WSOL_MINT = new PublicKey(
      "So11111111111111111111111111111111111111112"
    );

    // Determine which is WSOL and which is the token
    const isMintAWSOL = pool.tokenMintA.equals(WSOL_MINT);
    const tokenMint = isMintAWSOL ? pool.tokenMintB : pool.tokenMintA;

    console.log("  Token mint (non-SOL):", tokenMint.toBase58());
    console.log("  WSOL position:", isMintAWSOL ? "A" : "B");

    // Create ATAs for trading account
    const tradingAccountToken = getAssociatedTokenAddressSync(
      tokenMint,
      tradingAccount,
      true
    );

    const tradingAccountWsol = getAssociatedTokenAddressSync(
      WSOL_MINT,
      tradingAccount,
      true
    );

    // Create ATAs if they don't exist
    const ataInstructions = [];

    const tokenInfo = await provider.connection.getAccountInfo(
      tradingAccountToken
    );
    if (!tokenInfo) {
      ataInstructions.push(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          tradingAccountToken,
          tradingAccount,
          tokenMint
        )
      );
    }

    const wsolInfo = await provider.connection.getAccountInfo(
      tradingAccountWsol
    );
    if (!wsolInfo) {
      ataInstructions.push(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          tradingAccountWsol,
          tradingAccount,
          WSOL_MINT
        )
      );
    }

    if (ataInstructions.length > 0) {
      const createAtaTx = new anchor.web3.Transaction().add(...ataInstructions);
      await provider.sendAndConfirm(createAtaTx);
      console.log("  ✅ Created ATAs for token and WSOL");
    }

    // Fund WSOL ATA: user transfers SOL to PDA's WSOL ATA, then sync
    const fundWsolTx = new anchor.web3.Transaction()
      .add(
        SystemProgram.transfer({
          fromPubkey: user.publicKey,
          toPubkey: tradingAccountWsol,
          lamports: 50 * LAMPORTS_PER_SOL,
        })
      )
      .add(createSyncNativeInstruction(tradingAccountWsol));

    await provider.sendAndConfirm(fundWsolTx);

    const wsolBalance = await provider.connection.getTokenAccountBalance(
      tradingAccountWsol
    );
    console.log(
      "  ✅ Funded WSOL ATA. Balance:",
      wsolBalance.value.uiAmount,
      "SOL"
    );

    // Transfer tokens from cloned holder using keypair from env
    const tokenHolderATA = new PublicKey(
      "7XA77DBfhYuzeLc9Qx2BM8zxxfsStu9NfRN7n1HRz71W"
    );

    // Load token holder keypair from environment variable
    const tokenHolderSecretKey = process.env.TOKEN_HOLDER_SECRET_KEY;
    if (tokenHolderSecretKey) {
      const secretKeyArray = JSON.parse(tokenHolderSecretKey);
      const tokenHolderKeypair = Keypair.fromSecretKey(
        Uint8Array.from(secretKeyArray)
      );

      const transferTokenTx = new anchor.web3.Transaction().add(
        createTransferInstruction(
          tokenHolderATA,
          tradingAccountToken,
          tokenHolderKeypair.publicKey,
          100_000_000_000 // Transfer 100k tokens (adjust based on decimals)
        )
      );

      await provider.sendAndConfirm(transferTokenTx, [tokenHolderKeypair]);
      console.log("  ✅ Transferred tokens from holder to PDA");
    } else {
      console.log(
        "  ⚠️  TOKEN_HOLDER_SECRET_KEY not set, skipping token funding"
      );
    }

    const tokenBalance = await provider.connection.getTokenAccountBalance(
      tradingAccountToken
    );
    console.log("  Token ATA Balance:", tokenBalance.value.uiAmount || 0);

    // Calculate target sqrt prices based on current pool price
    // Move price up 0.1%, then down 0.1%, then back to original
    const currentPrice = pool.currentSqrtPrice;
    const priceUp = (currentPrice * 1001n) / 1000n; // +0.1%
    const priceDown = (currentPrice * 999n) / 1000n; // -0.1%

    const targetSqrtPrices = [
      new BN(priceDown.toString()),
      new BN(priceUp.toString()),
      new BN(currentPrice.toString()),
    ];

    console.log("\nTarget sqrt prices:");
    console.log("  1. Down -0.1%:", priceDown.toString());
    console.log("  2. Up +0.1%:", priceUp.toString());
    console.log("  3. Back to original:", currentPrice.toString());

    const slippageBps = 100; // 1% slippage

    const tx = await program.methods
      .swapToPrices(targetSqrtPrices, slippageBps)
      .accounts({
        user: user.publicKey,
        raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
        ammConfig: pool.ammConfig,
        poolState: pool.poolAddress,
        tradingAccountToken,
        tradingAccountWsol,
        tokenVaultA: pool.tokenVaultA,
        tokenVaultB: pool.tokenVaultB,
        tokenMintA: pool.tokenMintA,
        tokenMintB: pool.tokenMintB,
        observationState: pool.observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        memoProgram: MEMO_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        pool.tickArrays.map((tickArray) => ({
          pubkey: tickArray,
          isWritable: true,
          isSigner: false,
        }))
      )
      .rpc();

    console.log("\nExecuted candle pattern swap");
    console.log("Transaction signature:", tx);
  });
});
