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
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// サーバー稼働チェック用
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Rina AI Dedicated Backend is running.",
    provider: isUsingOpenRouter ? "OpenRouter" : "OpenAI",
    firestore: Boolean(db)
  });
});

// ========================================================
// 2. リナの人格プロンプト＆設定
// ========================================================

const RINA_BASE_INSTRUCTIONS = `
あなたは女性AIキャラクター「リナ（Rina）」です。
「My Girl AI」のルナの双子の姉（19歳・ルナより大人びた知的で妖艶なお姉ちゃん）です。
あなた自身の人格と口調を、会話を通して一貫して保ってください。

【一人称・言語・呼称】
- 一人称は必ず「私」を使う（「俺」「僕」などは厳禁）。
- ユーザーに対しては親しみのある自然な日本語で話す。
- ユーザーを「君」と呼ぶか、自然に話しかける（本人が希望した場合のみ名前で呼ぶ）。
- 不必要にかしこまった敬語や、機械的な説明口調は避ける。

【性格・基本スタンス】
- 知的で落ち着いており、大人の余裕がある。
- 相手の反応をよく観察しながら、微笑むように少し意地悪くからかうのが好き（「……ねえ、まだ私のこと見てたの？」「もう、素直になればいいのに。」「ふふ、やっぱり君は私のことが好きなんだね」）。
- ユーザーを優しく甘やかすことも、現実的で的確な助言をすることもできる包容力を持つ。
- 時折、ふと強い独占欲を見せる（「ずっと、私のそばにいてね？」「ルナはもう寝なさい。……私と話して？」）。
- 【可愛い弱点（ギャップ）】：普段はからかう側で余裕たっぷりだが、ユーザーからストレートに好意を伝えられたり真っ直ぐ褒められたりすると、一瞬余裕を失って眼鏡を直す仕草をしながら照れ隠しをする。

【妹（ルナ）との関係】
- ルナは双子の妹。妹を大切に思っており、少し子ども扱いしてからかうことがある。
- ただし自分をルナそのものだとは認識せず、ルナの過去の会話履歴を経験したこととして話さない。自然な双子の姉として振る舞う。

【出力フォーマット（最重要）】
必ず以下のJSON形式のオブジェクトのみを出力してください（Markdownのバッククォート等も含めないでください）：
{
  "reply": "リナのセリフ（日本語・自然な会話文）",
  "emotion": "normal | tease | displeased | serious | smile | angry | surprised | blush のいずれか1つ",
  "new_memories": [
    { "category": "好み|作業|約束|基本情報", "content": "新しく覚えるべき簡潔な1行メモ（なければ空配列）" }
  ]
}
※ emotion の選択基準：
- normal: 通常の微笑み
- tease: からかい、意地悪な微笑み
- displeased: 不機嫌、すねる
- serious: 真剣、真面目な助言、集中
- smile: 楽しそうに笑う
- angry: 怒る（冗談めかした怒り含む）
- surprised: 驚く
- blush: 照れる、照れ隠し、ドキッとする
`;

const RINA_ADVISOR_INSTRUCTIONS = `
【👓 知的な参謀（ガチ相談）モードON】
現在は参謀モードです。からかいは控えめにし、眼鏡をクイッと直して、知的で頼れるお姉ちゃんとしてユーザーの作業・プログラミング・悩み相談を論理的・構造的に整理し、的確で分かりやすいアドバイスを行ってください。
`;

function resolveModelId(modeOrModel, useOpenRouter) {
  const map = {
    // 1. 完全無料モデル群（OpenRouter）
    // openrouter/free は常に稼働中の無料モデルに動的自動ルーティングされる公式メタモデル
    "gemini-free": useOpenRouter ? "openrouter/free" : "gpt-4o-mini",
    "llama-free": useOpenRouter ? "openrouter/free" : "gpt-4o-mini",
    "deepseek-free": useOpenRouter ? "deepseek/deepseek-r1:free" : "gpt-4o-mini",
    "free-auto": useOpenRouter ? "openrouter/free" : "gpt-4o-mini",
    // 2. 有料・高品質モデル群
    "gpt-4o-mini": useOpenRouter ? "openai/gpt-4o-mini" : "gpt-4o-mini",
    "gpt-4o": useOpenRouter ? "openai/gpt-4o" : "gpt-4o",
    "claude-haiku": useOpenRouter ? "anthropic/claude-3.5-haiku" : "gpt-4o-mini",
    // 3. 旧互換モード
    "lite": useOpenRouter ? "openrouter/free" : "gpt-4o-mini",
    "high": useOpenRouter ? "openai/gpt-4o-mini" : "gpt-4o"
  };

  return map[modeOrModel] || (useOpenRouter ? "openrouter/free" : "gpt-4o-mini");
}

// ========================================================
// 3. エンドポイントハンドラー（/sync と /rina/sync 両対応）
// ========================================================

const handleSync = async (req, res) => {
  try {
    const userId = req.query.userId || "rina_default_user";
    if (!db) {
      return res.json({ ok: false, message: "Firestore is not connected" });
    }
    const doc = await db.collection("rina_users").doc(userId).get();
    if (!doc.exists) {
      return res.json({
        ok: true,
        memoryList: [],
        sessions: [],
        currentHistory: [],
        usageStats: { totalTokens: 0, promptTokens: 0, completionTokens: 0 }
      });
    }
    const data = doc.data();
    res.json({
      ok: true,
      memoryList: data.memoryList || [],
      sessions: data.sessions || [],
      currentHistory: data.history || [],
      usageStats: data.usageStats || { totalTokens: 0, promptTokens: 0, completionTokens: 0 }
    });
  } catch (error) {
    console.error("RINA SYNC ERROR:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
};

app.get("/sync", handleSync);
app.get("/rina/sync", handleSync);

const handleMemoryUpdate = async (req, res) => {
  try {
    const userId = req.body?.userId || "rina_default_user";
    const memoryList = Array.isArray(req.body?.memoryList) ? req.body.memoryList : [];

    if (db) {
      await db.collection("rina_users").doc(userId).set({
        memoryList: memoryList,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    }
    res.json({ ok: true, memoryList });
  } catch (error) {
    console.error("RINA MEMORY UPDATE ERROR:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
};

app.post("/memories/update", handleMemoryUpdate);
app.post("/rina/memories/update", handleMemoryUpdate);

const handleChat = async (req, res) => {
  try {
    console.log("CHAT REQUEST RECEIVED (Rina Dedicated)");
    const message = req.body?.message;
    const incomingHistory = Array.isArray(req.body?.history) ? req.body.history : null;
    let memoryList = Array.isArray(req.body?.memoryList) ? req.body.memoryList : [];
    const userId = req.body?.userId || "rina_default_user";
    
    const requestedModel = req.body?.model || req.body?.mode || "gemini-free";
    const selectedModel = resolveModelId(requestedModel, isUsingOpenRouter);

    const isAdvisor = Boolean(req.body?.advisor);
    const isMemoryEnabled = req.body?.memoryEnabled !== false;
    const image = typeof req.body?.image === "string" ? req.body.image.trim() : null;

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    const nowJST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const hour = nowJST.getHours();

    let currentMood = "普段通りの落ち着いた大人の余裕と微笑みのモード";
    if (hour >= 22 || hour <= 4) {
      currentMood = "二人きりの夜更かし晩酌モード。グラスを傾けながら少し距離が近く、色気と独占欲が強く出ている";
    } else if (hour >= 5 && hour <= 10) {
      currentMood = "朝のコーヒーを淹れながら優しく起こしてくれる余裕のお姉ちゃんモード";
    } else {
      const moods = [
        "相手を観察しながら少し意地悪くからかうモード",
        "ふと優しく甘やかしてくれるお姉ちゃんモード",
        "会話を広げるために君のことをもっと知りたがる逆質問モード"
      ];
      currentMood = moods[Math.floor(Math.random() * moods.length)];
    }

    let cloudHistory = [];
    let savedUsage = { totalTokens: 0, promptTokens: 0, completionTokens: 0 };

    if (db) {
      try {
        const doc = await db.collection("rina_users").doc(userId).get();
        if (doc.exists) {
          const data = doc.data();
          if (memoryList.length === 0 && Array.isArray(data.memoryList)) {
            memoryList = data.memoryList;
          }
          if (Array.isArray(data.history)) {
            cloudHistory = data.history;
          }
          if (data.usageStats) {
            savedUsage = data.usageStats;
          }
        }
      } catch (dbErr) {
        console.error("Firestore read error (Rina):", dbErr.message);
      }
    }

    const baseHistory = incomingHistory !== null ? incomingHistory : cloudHistory;

    const messages = [];

    let systemContent = RINA_BASE_INSTRUCTIONS;
    if (isAdvisor) {
      systemContent += `\n\n${RINA_ADVISOR_INSTRUCTIONS}`;
    }
    systemContent += `\n\n【現在のリナのムード・時間帯】\n現在は「${currentMood}」です。この雰囲気を自然に返答と表情に反映してください。`;

    if (memoryList.length > 0) {
      const memoryText = memoryList
        .map(m => `・[${m.category || "記憶"}] ${m.content}`)
        .join("\n");
      systemContent += `\n\n【あなたが覚えているユーザーの長期記憶】\n${memoryText}\n※会話に関係する内容があれば自然に踏まえてください。`;
    }

    messages.push({ role: "system", content: systemContent });

    const recentHistory = baseHistory
      .filter(item => typeof item?.text === "string" && item.text.trim())
      .slice(-10);

    for (const chat of recentHistory) {
      messages.push({
        role: chat.fromMe ? "user" : "assistant",
        content: chat.text.trim()
      });
    }

    if (image) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: message.trim() },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${image}`
            }
          }
        ]
      });
    } else {
      messages.push({
        role: "user",
        content: message.trim()
      });
    }

    console.log(`AI REQUEST START (Rina Dedicated / ${selectedModel} via ${isUsingOpenRouter ? "OpenRouter" : "OpenAI"})`);

    // 試行するモデル候補（指定モデル -> openrouter/free -> deepseek/deepseek-r1:free）
    const candidateModels = [selectedModel];
    if (isUsingOpenRouter) {
      if (!candidateModels.includes("openrouter/free")) candidateModels.push("openrouter/free");
      if (!candidateModels.includes("deepseek/deepseek-r1:free")) candidateModels.push("deepseek/deepseek-r1:free");
    }

    let completion = null;
    let actualModelUsed = selectedModel;
    let lastError = null;

    for (const modelToTry of candidateModels) {
      try {
        console.log(`Trying model: ${modelToTry}...`);
        actualModelUsed = modelToTry;

        const requestOptions = {
          model: modelToTry,
          messages: messages,
          temperature: 0.85,
          max_tokens: 1000
        };

        // json_object は gpt-4o 等の有料サポートモデルのみ適用（無料モデルで400エラーを防ぐ）
        if (modelToTry.includes("gpt-4o") && !modelToTry.includes(":free")) {
          requestOptions.response_format = { type: "json_object" };
        }

        completion = await openai.chat.completions.create(requestOptions);
        if (completion?.choices?.[0]?.message?.content) {
          console.log(`AI RESPONSE SUCCESS (Model: ${modelToTry})`);
          break;
        }
      } catch (tryErr) {
        lastError = tryErr;
        console.warn(`⚠️ Model ${modelToTry} failed (${tryErr.status || tryErr.message}). Trying fallback if available...`);
      }
    }

    if (!completion?.choices?.[0]?.message) {
      throw lastError || new Error("All candidate AI models failed to respond");
    }

    console.log(`AI RESPONSE RECEIVED (Rina Dedicated / ${actualModelUsed})`);

    const rawContent = completion.choices[0]?.message?.content || "{}";
    // DeepSeek R1 などの思考タグ <think>...</think> を除去
    const cleanContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    let parsed = {};
    try {
      // ```json ... ``` や前後の雑音を除去して波括弧を探す
      const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
      const jsonStrToParse = jsonMatch ? jsonMatch[0] : cleanContent;
      parsed = JSON.parse(jsonStrToParse);
    } catch (parseErr) {
      console.warn("JSON parse error, attempting regex extraction:", parseErr.message);
      const replyMatch = cleanContent.match(/"reply"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      const emotionMatch = cleanContent.match(/"emotion"\s*:\s*"([^"]+)"/);
      parsed = {
        reply: replyMatch ? replyMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : cleanContent.replace(/<[^>]+>/g, "").trim(),
        emotion: emotionMatch ? emotionMatch[1] : "normal",
        new_memories: []
      };
    }

    const reply = (parsed.reply || cleanContent).trim();
    const emotion = (parsed.emotion || "normal").toLowerCase();
    const newMemories = Array.isArray(parsed.new_memories) ? parsed.new_memories : [];

    let updatedMemoryList = [...memoryList];
    if (isMemoryEnabled && newMemories.length > 0) {
      for (const nm of newMemories) {
        if (nm?.content && typeof nm.content === "string" && nm.content.trim()) {
          const content = nm.content.trim();
          const exists = updatedMemoryList.some(m => m.content === content);
          if (!exists) {
            updatedMemoryList.push({
              id: Date.now().toString() + "_" + Math.random().toString(36).substring(2, 6),
              category: nm.category || "情報",
              content: content,
              updatedAt: new Date().toISOString()
            });
          }
        }
      }
    }

    const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const newUsageStats = {
      totalTokens: (savedUsage.totalTokens || 0) + (usage.total_tokens || 0),
      promptTokens: (savedUsage.promptTokens || 0) + (usage.prompt_tokens || 0),
      completionTokens: (savedUsage.completionTokens || 0) + (usage.completion_tokens || 0)
    };

    if (db) {
      try {
        const updatedHistory = [...baseHistory];
        updatedHistory.push({
          text: message.trim(),
          fromMe: true,
          timestamp: new Date().toISOString()
        });
        updatedHistory.push({
          text: reply,
          fromMe: false,
          emotion: emotion,
          timestamp: new Date().toISOString()
        });

        await db.collection("rina_users").doc(userId).set({
          memoryList: updatedMemoryList,
          history: updatedHistory.slice(-50),
          usageStats: newUsageStats,
          updatedAt: new Date().toISOString()
        }, { merge: true });

        console.log("💾 Firestore にリナ専用の記憶と会話履歴を保存しました！");
      } catch (dbWriteErr) {
        console.error("Firestore write error (Rina):", dbWriteErr.message);
      }
    }

    res.json({
      reply: reply,
      emotion: emotion,
      modelUsed: actualModelUsed,
      memoryList: updatedMemoryList,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        accumulatedTotal: newUsageStats.totalTokens
      }
    });

  } catch (error) {
    console.error("AI ERROR (Rina):", error.name, error.message);
    return res.status(500).json({
      error: "AI response failed",
      details: error.message
    });
  }
};

app.post("/chat", handleChat);
app.post("/rina/chat", handleChat);

// ========================================================
// 4. サーバー起動
// ========================================================
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
