require("dotenv").config();

const { ethers } = require("ethers");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const { keccak256 } = require("js-sha3");
const os = require("os");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)",
];

// ======================================================
// WORKER
// ======================================================

if (!isMainThread) {
  const { challenge, miner, target, workerId, totalWorkers } = workerData;

  const challengeBuf = Buffer.from(challenge.replace("0x", ""), "hex");

  const minerBuf = Buffer.from(miner.replace("0x", ""), "hex");

  const nonceBuf = Buffer.alloc(32);

  const combined = Buffer.allocUnsafe(84);

  challengeBuf.copy(combined, 0);
  minerBuf.copy(combined, 32);

  let nonce = BigInt(workerId);

  let hashes = 0;

  while (true) {
    let tmp = nonce;

    for (let i = 31; i >= 0; i--) {
      nonceBuf[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }

    nonceBuf.copy(combined, 52);

    const hashHex = keccak256(combined);

    const hashBig = BigInt("0x" + hashHex);

    if (hashBig < BigInt(target)) {
      parentPort.postMessage({
        type: "found",
        nonce: nonce.toString(),
        hash: "0x" + hashHex,
      });

      return;
    }

    nonce += BigInt(totalWorkers);

    hashes++;

    if (hashes >= 500000) {
      parentPort.postMessage({
        type: "progress",
        count: hashes,
      });

      hashes = 0;
    }
  }
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Isi RPC_URL dan PRIVATE_KEY di .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  const WORKERS = parseInt(process.env.WORKERS || os.cpus().length);

  console.log("================================");
  console.log("HASH256 CPU Miner");
  console.log("================================");
  console.log("Wallet :", wallet.address);
  console.log("Workers:", WORKERS);
  console.log("================================");

  while (true) {
    try {
      const state = await contract.miningState();

      const difficulty = BigInt(state.difficulty.toString());

      const challenge = await contract.getChallenge(wallet.address);

      const target = ((1n << 256n) - 1n) / difficulty;

      console.log("\n================================");
      console.log("Difficulty:", difficulty.toString());
      console.log("Challenge :", challenge);
      console.log("================================");

      let totalHashes = 0;

      const start = Date.now();

      const workers = [];

      let found = false;

      const nonce = await new Promise((resolve) => {
        const stats = setInterval(() => {
          const elapsed = (Date.now() - start) / 1000;

          const mh = (totalHashes / elapsed / 1000000).toFixed(2);

          process.stdout.write(
            `\r⛏ ${mh} MH/s | Hashes ${totalHashes.toLocaleString()}`,
          );
        }, 2000);

        for (let i = 0; i < WORKERS; i++) {
          const worker = new Worker(__filename, {
            workerData: {
              challenge,
              miner: wallet.address,
              target: target.toString(),
              workerId: i,
              totalWorkers: WORKERS,
            },
          });

          worker.on("message", (msg) => {
            if (msg.type === "progress") {
              totalHashes += msg.count;
            }

            if (msg.type === "found" && !found) {
              found = true;

              clearInterval(stats);

              workers.forEach((w) => w.terminate());

              console.log("\n");
              console.log("✅ NONCE FOUND");
              console.log("Nonce:", msg.nonce);
              console.log("Hash :", msg.hash);

              resolve(BigInt(msg.nonce));
            }
          });

          workers.push(worker);
        }
      });

      console.log("\n📡 Sending TX...");

      const tx = await contract.mine(nonce);

      console.log("TX:", tx.hash);

      const receipt = await tx.wait();

      console.log("✅ SUCCESS BLOCK:", receipt.blockNumber);
    } catch (err) {
      console.log("\n❌ ERROR");

      console.log(err.shortMessage || err.reason || err.message);

      console.log("\nRetry 5 sec...\n");

      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();
