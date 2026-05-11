require("dotenv").config();

const { ethers } = require("ethers");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const os = require("os");

// ─── Keccak: native C++ kalau ada, fallback JS ───────────────────────────────
let keccakFn;
try {
  const { createKeccakHash } = require("keccak");
  keccakFn = (buf) => createKeccakHash("keccak256").update(buf).digest();
} catch {
  const { keccak256 } = require("js-sha3");
  keccakFn = (buf) => Buffer.from(keccak256(buf), "hex");
}

// ─── Config ───────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS || "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const WORKERS = parseInt(process.env.WORKERS || os.cpus().length);

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)",
];

// =============================================================================
// WORKER THREAD
// =============================================================================
if (!isMainThread) {
  const { challenge, miner, targetHex, workerId, totalWorkers } = workerData;

  const targetBuf = Buffer.from(targetHex.replace("0x", ""), "hex");

  // Buffer 84 byte: [challenge 32][miner 20][nonce 32]
  const combined = Buffer.allocUnsafe(84);
  Buffer.from(challenge.replace("0x", ""), "hex").copy(combined, 0);
  Buffer.from(miner.replace("0x", ""), "hex").copy(combined, 32);
  combined.fill(0, 52, 76); // padding nonce (byte atas = 0)

  // Nonce 64-bit: dua uint32 supaya tidak kena float precision
  let nonceHi = 0;
  let nonceLo = workerId >>> 0;

  let hashes = 0;

  function isValid(hashBuf) {
    for (let i = 0; i < 32; i++) {
      if (hashBuf[i] < targetBuf[i]) return true;
      if (hashBuf[i] > targetBuf[i]) return false;
    }
    return false;
  }

  while (true) {
    combined[76] = (nonceHi >>> 24) & 0xff;
    combined[77] = (nonceHi >>> 16) & 0xff;
    combined[78] = (nonceHi >>> 8) & 0xff;
    combined[79] = nonceHi & 0xff;
    combined[80] = (nonceLo >>> 24) & 0xff;
    combined[81] = (nonceLo >>> 16) & 0xff;
    combined[82] = (nonceLo >>> 8) & 0xff;
    combined[83] = nonceLo & 0xff;

    const hashBuf = keccakFn(combined);

    if (isValid(hashBuf)) {
      const nonce = (BigInt(nonceHi) << 32n) | BigInt(nonceLo >>> 0);
      parentPort.postMessage({
        type: "found",
        nonce: nonce.toString(),
        hash: "0x" + hashBuf.toString("hex"),
      });
      return;
    }

    nonceLo = (nonceLo + totalWorkers) >>> 0;
    if (nonceLo < totalWorkers) nonceHi = (nonceHi + 1) >>> 0;

    if (++hashes >= 500_000) {
      parentPort.postMessage({ type: "progress", count: hashes });
      hashes = 0;
    }
  }
}

// =============================================================================
// MAIN THREAD
// =============================================================================
function checkEnv() {
  if (!RPC_URL) {
    console.error("❌ RPC_URL tidak diset di .env");
    process.exit(1);
  }
  if (!PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY tidak diset di .env");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x")) {
    console.error("❌ PRIVATE_KEY harus diawali 0x");
    process.exit(1);
  }
}

async function mine(contract, wallet, targetHex, challenge) {
  let totalHashes = 0;
  let found = false;
  const start = Date.now();

  return new Promise((resolve) => {
    const stats = setInterval(() => {
      const sec = (Date.now() - start) / 1000;
      const mh = (totalHashes / sec / 1_000_000).toFixed(2);
      process.stdout.write(
        `\r⛏  ${mh} MH/s | ${totalHashes.toLocaleString()} hashes | ${sec.toFixed(0)}s`,
      );
    }, 1000);

    const workers = [];

    for (let i = 0; i < WORKERS; i++) {
      const w = new Worker(__filename, {
        workerData: {
          challenge,
          miner: wallet.address,
          targetHex,
          workerId: i,
          totalWorkers: WORKERS,
        },
      });

      w.on("message", (msg) => {
        if (msg.type === "progress") totalHashes += msg.count;

        if (msg.type === "found" && !found) {
          found = true;
          clearInterval(stats);
          workers.forEach((x) => x.terminate());

          const sec = (Date.now() - start) / 1000;
          const mh = (totalHashes / sec / 1_000_000).toFixed(2);
          console.log(`\n\n✅ Nonce ketemu!`);
          console.log(`   Nonce : ${msg.nonce}`);
          console.log(`   Hash  : ${msg.hash}`);
          console.log(`   Speed : ${mh} MH/s rata-rata`);

          resolve(BigInt(msg.nonce));
        }
      });

      w.on("error", (err) =>
        console.error(`\n⚠️  Worker ${i} error:`, err.message),
      );
      workers.push(w);
    }
  });
}

async function main() {
  checkEnv();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log("╔══════════════════════════════════════╗");
  console.log("║        HASH256 CPU Miner             ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`Wallet   : ${wallet.address}`);
  console.log(`Contract : ${CONTRACT_ADDRESS}`);
  console.log(`Workers  : ${WORKERS} (dari ${os.cpus().length} core tersedia)`);
  try {
    require("keccak");
    console.log("Keccak   : Native C++ ✅");
  } catch {
    console.log(
      "Keccak   : JS fallback ⚠️  (npm install keccak untuk lebih cepat)",
    );
  }
  console.log("════════════════════════════════════════");

  while (true) {
    try {
      const [state, challenge] = await Promise.all([
        contract.miningState(),
        contract.getChallenge(wallet.address),
      ]);

      const difficulty = BigInt(state.difficulty.toString());
      const target = ((1n << 256n) - 1n) / difficulty;
      const targetHex = "0x" + target.toString(16).padStart(64, "0");

      console.log(`\nEra        : ${state.era}`);
      console.log(`Reward     : ${ethers.formatUnits(state.reward, 18)} HASH`);
      console.log(`Difficulty : ${difficulty}`);
      console.log(`Epoch      : ${state.epoch}`);
      console.log(`Challenge  : ${challenge}`);
      console.log("════════════════════════════════════════");

      const nonce = await mine(contract, wallet, targetHex, challenge);

      console.log("\n📡 Mengirim TX...");
      const tx = await contract.mine(nonce);
      console.log(`   TX   : ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ Masuk block: ${receipt.blockNumber}`);
    } catch (err) {
      console.error(
        "\n❌ Error:",
        err.shortMessage || err.reason || err.message,
      );
      console.log("Retry 5 detik...");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
