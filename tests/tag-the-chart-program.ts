import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { TagTheChartProgram } from "../target/types/tag_the_chart_program";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { fetchPoolAccounts } from "./utils/pool-helper";
import { expect } from "chai";

import * as dotenv from "dotenv";

dotenv.config();

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

// Wrapped SOL mint
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

describe("tag-the-chart-program", () => {
  // Load user from .env TOKEN_HOLDER_SECRET_KEY
  const tokenHolderSecretKey = process.env.TOKEN_HOLDER_SECRET_KEY;
  if (!tokenHolderSecretKey) {
    throw new Error("TOKEN_HOLDER_SECRET_KEY not set in .env");
  }
  const secretKeyArray = JSON.parse(tokenHolderSecretKey);
  const user = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

  // Create provider with user wallet
  const userWallet = new anchor.Wallet(user);
  const provider = new anchor.AnchorProvider(
    anchor.AnchorProvider.env().connection,
    userWallet,
    {
      commitment: "processed",
      preflightCommitment: "processed",
      skipPreflight: false,
    }
  );
  anchor.setProvider(provider);

  const program = anchor.workspace
    .tagTheChartProgram as Program<TagTheChartProgram>;

  // Test variables
  let tradingAccount: PublicKey;
  let tokenMint: PublicKey;
  let userWsolAta: PublicKey;
  let userTokenAta: PublicKey;
  let pdaWsolAta: PublicKey;
  let pdaTokenAta: PublicKey;

  before("Setup test environment", async () => {
    console.log("\n🔧 Setting up test environment...\n");
    console.log("  User (from .env):", user.publicKey.toBase58());

    // Airdrop SOL for transaction fees
    const airdropSig = await provider.connection.requestAirdrop(
      user.publicKey,
      5 * LAMPORTS_PER_SOL
    );

    await provider.connection.confirmTransaction(airdropSig);
    console.log("  ✅ Airdropped 5 SOL for fees");

    // Initialize trading account PDA
    [tradingAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("trading_account"), user.publicKey.toBuffer()],
      program.programId
    );

    await program.methods.initialize().accounts({ user: user.publicKey }).rpc();
    console.log("  ✅ Initialized trading account");

    // Fetch pool to determine token mints
    const pool = await fetchPoolAccounts(POOL_ADDRESS);
    const isMintAWSOL = pool.tokenMintA.equals(WSOL_MINT);
    tokenMint = isMintAWSOL ? pool.tokenMintB : pool.tokenMintA;
    console.log("  Token mint (non-SOL):", tokenMint.toBase58());

    // Calculate ATAs
    userWsolAta = getAssociatedTokenAddressSync(
      WSOL_MINT,
      user.publicKey,
      false
    );
    userTokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      user.publicKey,
      false
    );
    pdaWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, tradingAccount, true);
    pdaTokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      tradingAccount,
      true
    );

    // Create all ATAs if needed
    const ataInstructions = [];

    const userWsolInfo = await provider.connection.getAccountInfo(userWsolAta);
    if (!userWsolInfo) {
      ataInstructions.push(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          userWsolAta,
          user.publicKey,
          WSOL_MINT
        )
      );
    }

    const userTokenInfo = await provider.connection.getAccountInfo(
      userTokenAta
    );
    if (!userTokenInfo) {
      ataInstructions.push(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          userTokenAta,
          user.publicKey,
          tokenMint
        )
      );
    }

    const pdaWsolInfo = await provider.connection.getAccountInfo(pdaWsolAta);
    if (!pdaWsolInfo) {
      ataInstructions.push(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          pdaWsolAta,
          tradingAccount,
          WSOL_MINT
        )
      );
    }

    const pdaTokenInfo = await provider.connection.getAccountInfo(pdaTokenAta);
    if (!pdaTokenInfo) {
      ataInstructions.push(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          pdaTokenAta,
          tradingAccount,
          tokenMint
        )
      );
    }

    if (ataInstructions.length > 0) {
      const createAtaTx = new anchor.web3.Transaction().add(...ataInstructions);
      await provider.sendAndConfirm(createAtaTx);
    }

    // User already has tokens from .env account (0.01 SOL + 100 tokens)
    console.log("  ✅ User token account:", userTokenAta.toBase58());

    // Wrap the user's 0.01 SOL to WSOL
    const wrapAmount = 0.1 * LAMPORTS_PER_SOL;
    const wrapTx = new anchor.web3.Transaction()
      .add(
        SystemProgram.transfer({
          fromPubkey: user.publicKey,
          toPubkey: userWsolAta,
          lamports: wrapAmount,
        })
      )
      .add(createSyncNativeInstruction(userWsolAta));
    await provider.sendAndConfirm(wrapTx);
  });

  it.skip("Deposit both pool tokens (WSOL + Token)", async () => {
    // Deposit 0.005 WSOL to PDA (half of available 0.01)

    const wsolDepositAmount = new BN(0.005 * LAMPORTS_PER_SOL);
    await program.methods
      //@ts-expect-error
      .deposit(wsolDepositAmount)
      .accounts({
        userTokenAccount: userWsolAta,
        pdaTokenAccount: pdaWsolAta,
        mint: WSOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Deposit 50 tokens to PDA (half of available 100)
    const tokenDepositAmount = new BN(50_000_000_000); // 50 tokens
    await program.methods
      //@ts-expect-error
      .deposit(tokenDepositAmount)
      .accounts({
        userTokenAccount: userTokenAta,
        pdaTokenAccount: pdaTokenAta,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify balances
    const pdaWsolBalance = await provider.connection.getTokenAccountBalance(
      pdaWsolAta
    );
    const pdaTokenBalance = await provider.connection.getTokenAccountBalance(
      pdaTokenAta
    );

    expect(pdaWsolBalance.value.uiAmount).to.equal(0.005);
    expect(pdaTokenBalance.value.uiAmount).to.equal(50);
  });

  it.skip("Withdraw both pool tokens (WSOL + Token)", async () => {
    // Get balances before withdrawal
    const userWsolBefore = await provider.connection.getTokenAccountBalance(
      userWsolAta
    );
    const userTokenBefore = await provider.connection.getTokenAccountBalance(
      userTokenAta
    );
    const pdaWsolBefore = await provider.connection.getTokenAccountBalance(
      pdaWsolAta
    );
    const pdaTokenBefore = await provider.connection.getTokenAccountBalance(
      pdaTokenAta
    );

    // Withdraw 0.002 WSOL from PDA
    const wsolWithdrawAmount = new BN(0.002 * LAMPORTS_PER_SOL);
    await program.methods
      //@ts-expect-error
      .withdraw(wsolWithdrawAmount)
      .accounts({
        userTokenAccount: userWsolAta,
        pdaTokenAccount: pdaWsolAta,
        mint: WSOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Withdraw 20 tokens from PDA
    const tokenWithdrawAmount = new BN(20_000_000_000); // 20 tokens
    await program.methods
      //@ts-expect-error
      .withdraw(tokenWithdrawAmount)
      .accounts({
        userTokenAccount: userTokenAta,
        pdaTokenAccount: pdaTokenAta,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify balances after withdrawal
    const userWsolAfter = await provider.connection.getTokenAccountBalance(
      userWsolAta
    );
    const userTokenAfter = await provider.connection.getTokenAccountBalance(
      userTokenAta
    );
    const pdaWsolAfter = await provider.connection.getTokenAccountBalance(
      pdaWsolAta
    );
    const pdaTokenAfter = await provider.connection.getTokenAccountBalance(
      pdaTokenAta
    );

    // User balances should increase
    expect(userWsolAfter.value.uiAmount).to.equal(
      (userWsolBefore.value.uiAmount || 0) + 0.002
    );
    expect(userTokenAfter.value.uiAmount).to.equal(
      (userTokenBefore.value.uiAmount || 0) + 20
    );

    // PDA balances should decrease
    expect(pdaWsolAfter.value.uiAmount).to.equal(
      (pdaWsolBefore.value.uiAmount || 0) - 0.002
    );
    expect(pdaTokenAfter.value.uiAmount).to.equal(
      (pdaTokenBefore.value.uiAmount || 0) - 20
    );
  });

  it.skip("Swap to target prices with forked pool", async () => {
    const pool = await fetchPoolAccounts(POOL_ADDRESS);

    await program.methods
      //@ts-expect-error
      .deposit(new BN(0.01 * LAMPORTS_PER_SOL))
      .accounts({
        userTokenAccount: userWsolAta,
        pdaTokenAccount: pdaWsolAta,
        mint: WSOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await program.methods
      //@ts-expect-error
      .deposit(new BN(50_000_000_000))
      .accounts({
        userTokenAccount: userTokenAta,
        pdaTokenAccount: pdaTokenAta,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Move price up 0.1%, then down 0.1%, then back to original
    const currentPrice = pool.currentSqrtPrice;
    const priceUp = (currentPrice * 1001n) / 1000n; // +0.1%
    const priceDown = (currentPrice * 999n) / 1000n; // -0.1%

    const targetSqrtPrices = [
      new BN(priceDown.toString()),
      new BN(priceUp.toString()),
      new BN(currentPrice.toString()),
    ];

    // Request more compute units for 3 swaps (each swap ~70k CU)
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000, // 400k CU should be enough for 3 swaps
    });

    // No slippage protection (0 = unlimited input, 0 = no min output)
    const maxInputs = [new BN(0), new BN(0), new BN(0)];
    const minOutputs = [new BN(0), new BN(0), new BN(0)];

    const tx = await program.methods
      //@ts-expect-error
      .swapToPrices(targetSqrtPrices, maxInputs, minOutputs)
      .accounts({
        user: user.publicKey,
        //@ts-ignore
        raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
        ammConfig: pool.ammConfig,
        poolState: pool.poolAddress,
        tradingAccountToken: pdaTokenAta,
        tradingAccountWsol: pdaWsolAta,
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
      .preInstructions([computeBudgetIx])
      .rpc();

    console.log("  ✅ Executed candle pattern swap");
    console.log("  Transaction signature:", tx);
  });

  it.only("Swap to target prices (simple - no PDA)", async () => {
    const pool = await fetchPoolAccounts(POOL_ADDRESS);

    // Move price down 0.1%, then up 0.1%, then back to original
    const currentPrice = pool.currentSqrtPrice;
    const priceDown = (currentPrice * 999n) / 1000n; // -0.1%
    const priceUp = (currentPrice * 1001n) / 1000n; // +0.1%

    const targetSqrtPrices = [
      new BN(priceDown.toString()),
      new BN(priceUp.toString()),
      new BN(currentPrice.toString()),
    ];

    // Request more compute units for 3 swaps
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });

    // No slippage protection (0 = unlimited input, 0 = no min output)
    const maxInputs = [new BN(0), new BN(0), new BN(0)];
    const minOutputs = [new BN(0), new BN(0), new BN(0)];

    const tx = await program.methods
      .swapToPricesSimple(targetSqrtPrices, maxInputs, minOutputs)
      .accounts({
        wallet: user.publicKey,
        splAta: userTokenAta,
        wsolAta: userWsolAta,
        //@ts-ignore
        raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
        ammConfig: pool.ammConfig,
        poolState: pool.poolAddress,
        tokenVaultA: pool.tokenVaultA,
        tokenVaultB: pool.tokenVaultB,
        tokenMintA: pool.tokenMintA,
        tokenMintB: pool.tokenMintB,
        observationState: pool.observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        memoProgram: MEMO_PROGRAM_ID,
        associatedTokenProgram: new PublicKey(
          "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        ),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        pool.tickArrays.map((tickArray) => ({
          pubkey: tickArray,
          isWritable: true,
          isSigner: false,
        }))
      )
      .preInstructions([computeBudgetIx])
      .rpc();

    console.log("  ✅ Executed candle pattern swap (simple - no PDA)");
    console.log("  Transaction signature:", tx);
  });
});
