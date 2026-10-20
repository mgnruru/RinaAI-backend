import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import OpenAI from "openai";
const app = express();
const port = process.env.PORT || 10000;
// ========================================================
// 1. 各種APIクライアントの初期化（リナ専用）
// ========================================================
const openRouterKey = process.env.OPENROUTER_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const isUsingOpenRouter = Boolean(openRouterKey) || (openaiKey && openaiKey.startsWith("sk-or-"));
const rinaApiKey = openRouterKey || openaiKey;
const openai = new OpenAI({
  apiKey: rinaApiKey,
  baseURL: isUsingOpenRouter ? "https://openrouter.ai/api/v1" : undefined,
  defaultHeaders: isUsingOpenRouter ? {
    "HTTP-Referer": "https://rina-ai-backend.onrender.com",
    "X-Title": "Rina AI"
  } : undefined
});
console.log(`🍷 リナ専用バックエンド起動 - 接続先: ${isUsingOpenRouter ? "OpenRouter" : "OpenAI Direct"}`);
// 🔥 Firebase Firestore（クラウドデータベース）の接続
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT.trim());
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("🔥 Firebase Firestore 接続成功！");
  } else {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT が設定されていないため、Firestoreは無効です。");
  }
} catch (e) {
  console.error("⚠️ Firebase初期化エラー:", e.message);
}
app.use(cors());
