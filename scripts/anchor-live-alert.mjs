// Anchor the fd21174f5a2b LIVE alert on Solana devnet.
// Reuses anchor-devnet.ts's payer-resolution + memo-program pattern, but
// sends a single memo tx and APPENDS to data/anchors.json instead of
// overwriting it (that script's writeFileSync would destroy the 3 existing
// replay-fixture anchors).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RPC = process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";
const KP_PATH = process.env.SOLANA_PAYER_KEYPAIR;
const ANCHORS_PATH = "/home/claude/code/fairwhistle/data/anchors.json";

const CORE_HASH = "fd21174f5a2ba63aebf23e893161606712472e8510646051c5e052f356c36e01";
const MEMO = `fairwhistle:v1:live:18257739:velocity_live:${CORE_HASH}`;

async function main() {
  if (!KP_PATH || !existsSync(KP_PATH)) {
    throw new Error(`SOLANA_PAYER_KEYPAIR not set or not found: ${KP_PATH}`);
  }
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KP_PATH, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`payer ${payer.publicKey.toBase58()} balance ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const existing = JSON.parse(readFileSync(ANCHORS_PATH, "utf8"));
  if (existing.some((r) => r.coreHash === CORE_HASH)) {
    console.log("already anchored, skipping");
    return;
  }

  let record;
  if (bal < 0.001 * LAMPORTS_PER_SOL) {
    console.error("insufficient balance — recording simulated");
    record = { coreHash: CORE_HASH, status: "simulated", note: "devnet payer balance too low at anchor time", memo: MEMO };
  } else {
    try {
      const tx = new Transaction().add(
        new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(MEMO, "utf8") }),
      );
      const txSig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
      console.log(`anchored velocity_live: ${txSig}`);
      record = {
        coreHash: CORE_HASH,
        status: "anchored",
        cluster: "devnet",
        txSignature: txSig,
        explorerUrl: `https://explorer.solana.com/tx/${txSig}?cluster=devnet`,
        anchoredAt: new Date().toISOString(),
        memo: MEMO,
      };
    } catch (e) {
      console.error(`anchor failed: ${e instanceof Error ? e.message : e}`);
      record = { coreHash: CORE_HASH, status: "simulated", note: "devnet send failed at anchor time", memo: MEMO };
    }
  }

  const updated = [...existing, record];
  writeFileSync(ANCHORS_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log(`appended to ${ANCHORS_PATH} (${updated.length} records total)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
