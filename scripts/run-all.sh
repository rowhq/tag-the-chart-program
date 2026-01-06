#!/bin/bash
set -e

echo "🚀 Running complete swap pipeline on devnet"
echo "==========================================="
echo ""

cd "$(dirname "$0")/.."

echo "Step 1: Creating PDA..."
ts-node scripts/1-create-pda.ts
echo ""

echo "Step 2: Creating ATAs..."
ts-node scripts/2-create-atas.ts
echo ""

echo "Step 3: Depositing SOL..."
ts-node scripts/3-deposit-sol.ts
echo ""

echo "Step 4: Depositing tokens..."
ts-node scripts/4-deposit-tokens.ts
echo ""

echo "Step 5: Executing swap..."
ts-node scripts/5-execute-swap.ts
echo ""

echo "✅ Complete! All steps executed successfully."
