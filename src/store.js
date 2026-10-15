/*
 * Storage for the shared app state: settings, stock file, and the two saved orders.
 * Uses MongoDB when MONGODB_URI / MONGODB_DIRECT_URI is set (production on Render or local Atlas),
 * otherwise falls back smoothly to a JSON file in ./data.
 */
const fs = require("fs");
const path = require("path");

const KEYS = ["settings", "stock", "plan-HR", "plan-NGO"];

function fileStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  return {
    kind: "file",
    async getAll() { return read(); },
    async put(key, data) {
      const all = read();
      all[key] = { data, updatedAt: Date.now() };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all));
      return all[key];
    }
  };
}

// Convert cluster0.fxhfgqv.mongodb.net SRV URI to direct replica-set URI to bypass local DNS restrictions
function toDirectUri(uri) {
  if (!uri || !uri.includes("cluster0.fxhfgqv.mongodb.net")) return uri;
  const match = uri.match(/^mongodb\+srv:\/\/([^:]+):([^@]+)@cluster0\.fxhfgqv\.mongodb\.net(\/?[^\?]*)(\??.*)$/);
  if (!match) return uri;
  const [, user, pass] = match;
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@ac-c0h7od9-shard-00-00.fxhfgqv.mongodb.net:27017,ac-c0h7od9-shard-00-01.fxhfgqv.mongodb.net:27017,ac-c0h7od9-shard-00-02.fxhfgqv.mongodb.net:27017/?ssl=true&replicaSet=atlas-lazgyd-shard-0&authSource=admin&retryWrites=true&w=majority`;
}

async function mongoStore(uri) {
  const { MongoClient } = require("mongodb");
  let client;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    console.log("Connected to MongoDB Atlas successfully!");
  } catch (err) {
    // If SRV lookup failed due to DNS, try the direct replica set URI
    const direct = toDirectUri(uri);
    if (direct !== uri) {
      console.log("SRV DNS failed, attempting direct replica set connection...");
      client = new MongoClient(direct, { serverSelectionTimeoutMS: 6000 });
      await client.connect();
      console.log("Connected to MongoDB Atlas via direct replica set!");
    } else {
      throw err;
    }
  }

  const col = client.db(process.env.MONGODB_DB || "cpl2").collection("state");
  return {
    kind: "mongodb",
    async getAll() {
      const docs = await col.find({ _id: { $in: KEYS } }).toArray();
      const out = {};
      docs.forEach(d => { out[d._id] = { data: d.data, updatedAt: d.updatedAt }; });
      return out;
    },
    async put(key, data) {
      const doc = { data, updatedAt: Date.now() };
      await col.updateOne({ _id: key }, { $set: doc }, { upsert: true });
      return doc;
    }
  };
}

async function createStore() {
  const uri = process.env.MONGODB_DIRECT_URI || process.env.MONGODB_URI;
  if (uri) {
    try {
      return await mongoStore(uri);
    } catch (err) {
      console.warn("MongoDB connection failed (" + err.message + "). Falling back to local file store.");
    }
  }
  return fileStore(path.join(__dirname, "..", "data", "state.json"));
}

module.exports = { createStore, KEYS };
