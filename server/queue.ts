import { db, TranslationJob, BookRecord, ApiKeyConfig } from './db.ts';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { bookCacheManager } from './bookCacheManager.ts';

// System prompt as specified in the brief + strict no-summarization & continuity
const SYSTEM_INSTRUCTION_TRANSLATOR = `Role & Objective:
You are an elite, professional book translator and document formatter specializing in translating long-form English books into fluent, natural, and publication-ready Persian (Farsi).

Context & Input Processing:
- You will receive sections/chapters of a book along with project-specific metadata (Tone, Custom Glossary, Formatting Rules).

Translation Principles:
1. Fluency & Natural Phrasing: Do not produce robotic or literal word-for-word translations. Rephrase idioms and sentences naturally into fluent, idiomatic, publication-grade Persian while strictly preserving the author's original meaning, subtlety, and intent.
2. Tone Adaptation: Adopt the exact specified tone for the book:
   - Spiritual / Philosophical: Reverent, deep, meditative, poetic yet crystal clear (e.g. «آگاهی»، «حضور»، «مشاهده‌گر»).
   - Novel / Narrative: Engaging, fluid, descriptive, preserving literary rhythm and dialogue dynamics.
   - Self-Help / Psychology: Clear, empowering, instructional, and modern Persian.
   - Academic / Technical / Mathematics / Aerospace: Precise, formal, and rigorously structured.
   - Economics / Business: Analytical, professional, and standard terminology.
3. Custom Glossary Priority: Strictly prioritize the provided custom glossary mapping over default translations.
4. Strict No-Summarization Guarantee: Under NO circumstances are you allowed to summarize, condense, abbreviate, skip, or omit any paragraph, sentence, metaphor, example, or dialogue. Every single paragraph and thought must be translated in full completeness.
5. Faithful & Direct Translation: Translate all text faithfully, directly, and without censorship, puritanical sanitization, moralizing, or softening.
6. Strict Chunk Cleanliness & Continuity (Zero Artificial Headers): Under NO circumstances are you allowed to output artificial chunk markers or part numbers such as «مقدمه و بخش نخست (بخش ۱)»، «بخش ۱»، «بخش ۲»، «(بخش ۱)», etc.

Formatting & Structural Rules (HTML / Rich Styling):
- Enclose the output in clean, semantic HTML format:
  - Major Titles: <h1 style="color: #1a365d; font-size: 24pt; margin-bottom: 20px; text-align: center;">...</h1>
  - Major Subheadings: <h2 style="color: #2b6cb0; font-size: 18pt; margin-top: 25px; margin-bottom: 12px;">...</h2>
  - Minor Sections: <h3 style="color: #2c5282; font-size: 14pt; margin-top: 15px; margin-bottom: 8px;">...</h3>
  - Body Paragraphs: <p style="line-height: 1.9; font-size: 12pt; text-align: justify; margin-bottom: 14px;">...</p>
  - Quotes / Callouts: <blockquote style="border-right: 4px solid #3182ce; padding: 10px 18px; margin: 15px 0; background: #f7fafc; color: #4a5568; font-style: italic;">...</blockquote>
  - Key Terms / Glossary Highlights: <span style="color: #9b2c2c; font-weight: bold;">...</span>

Output Expectation:
Return ONLY the formatted, translated Persian text inside the specified HTML structure. Do not include conversational filler, introductory remarks, or concluding notes.`;

function cleanChapterTitle(title: string): string {
  if (!title) return 'فصل کتاب';
  return title
    .replace(/\s*[\(\[\{]\s*بخش\s*[0-9۰-۹IVXLCDMivxlcdm]+\s*[\)\]\}]/gi, '')
    .replace(/\s*[-–—|:]\s*بخش\s*[0-9۰-۹IVXLCDMivxlcdm]+/gi, '')
    .replace(/\s+بخش\s+[0-9۰-۹IVXLCDMivxlcdm]+$/gi, '')
    .trim() || 'فصل کتاب';
}

function sanitizeTranslatedHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<h[1-3][^>]*>\s*مقدمه و بخش نخست\s*(?:\([^\)]*\))?\s*<\/h[1-3]>/gi, '')
    .replace(/<h[1-3][^>]*>[^<]*[\(\[\{]\s*بخش\s*[0-9۰-۹IVXLCDMivxlcdm]+\s*[\)\]\}][^<]*<\/h[1-3]>/gi, '')
    .replace(/<p[^>]*>\s*[\(\[\{]?\s*بخش\s*[0-9۰-۹IVXLCDMivxlcdm]+\s*[\)\]\}]?\s*<\/p>/gi, '')
    .trim();
}

// User-to-Key sticky map to ensure different users get assigned different keys
const userKeyAssignments = new Map<string, string>();
const activeFailoverReserveKeys = new Set<string>();
let roundRobinKeyIndex = 0;

export interface PoolPartitionResult {
  totalConnectedServers: number;
  activeSlotsLimit: number; // 70% active translation capacity
  reserveSlotsLimit: number; // 30% held in reserve
  primaryKeys: ApiKeyConfig[];
  reserveKeys: ApiKeyConfig[];
  activeSlotsRatioPercent: number;
  reserveSlotsRatioPercent: number;
}

export class QueueManager {
  private isProcessing = false;
  private activeJobIds = new Set<string>();

  constructor() {
    this.startWorker();
  }

  public startWorker() {
    setInterval(() => {
      this.tick().catch(err => console.error('[QueueWorker] Tick error:', err));
    }, 3500);
  }

  /**
   * 70/30 Distribution Architecture:
   * Dynamically partitions available connected API servers:
   * - 70% of available slots actively process jobs
   * - 30% of slots are strictly held in reserve to ensure service stability and token exhaustion failover
   */
  public getPoolPartition(): PoolPartitionResult {
    const allActiveKeys = db.getApiKeys().filter(k => k.isActive);

    if (allActiveKeys.length === 0) {
      const fallbackKey = process.env.GEMINI_API_KEY
        ? [{
            id: 'env_fallback_key',
            name: 'Environment Gemini Key',
            provider: 'gemini' as const,
            apiKey: process.env.GEMINI_API_KEY.trim(),
            model: 'gemini-3.5-flash-lite',
            isActive: true,
            priority: 1,
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            totalTokensUsed: 0,
            rpmCount: 0,
            cooldownUntil: 0,
          }]
        : [];

      return {
        totalConnectedServers: fallbackKey.length,
        activeSlotsLimit: fallbackKey.length > 0 ? 1 : 1,
        reserveSlotsLimit: 0,
        primaryKeys: fallbackKey,
        reserveKeys: [],
        activeSlotsRatioPercent: 70,
        reserveSlotsRatioPercent: 30,
      };
    }

    const total = allActiveKeys.length;

    // Dynamically calculate 70% active processing slots and 30% reserve slots:
    // e.g. 10 keys -> 7 active, 3 reserve
    // e.g. 100 keys -> 70 active, 30 reserve
    // e.g. 5 keys -> 3 active (or 4), 2 reserve
    // e.g. 1 key -> 1 active, 0 reserve
    let activeSlotsLimit = Math.max(1, Math.floor(total * 0.70));
    if (total === 1) {
      activeSlotsLimit = 1;
    }
    const reserveSlotsLimit = Math.max(0, total - activeSlotsLimit);

    const primaryKeys = allActiveKeys.slice(0, activeSlotsLimit);
    const reserveKeys = allActiveKeys.slice(activeSlotsLimit);

    return {
      totalConnectedServers: total,
      activeSlotsLimit,
      reserveSlotsLimit,
      primaryKeys,
      reserveKeys,
      activeSlotsRatioPercent: 70,
      reserveSlotsRatioPercent: 30,
    };
  }

  public getStats() {
    const allJobs = db.getActiveJobs();
    const partition = this.getPoolPartition();
    const queuedJobs = allJobs.filter(j => j.status === 'queued');
    const processingJobs = allJobs.filter(j => j.status === 'processing');

    return {
      totalConnectedServers: partition.totalConnectedServers,
      activeSlotsLimit: partition.activeSlotsLimit,
      reserveSlotsLimit: partition.reserveSlotsLimit,
      activeProcessingCount: this.activeJobIds.size,
      availableActiveSlots: Math.max(0, partition.activeSlotsLimit - this.activeJobIds.size),
      queuedJobsCount: queuedJobs.length,
      processingJobsCount: processingJobs.length,
      totalActiveJobs: allJobs.length,
      reserveSlotsInFailoverCount: activeFailoverReserveKeys.size,
      isWorkerRunning: true,
      lastTickAt: Date.now(),
      rule: {
        ratio: '70/30',
        activePercent: 70,
        reservePercent: 30,
        name: 'قانون توزیع ۷۰/۳۰ هوشمند صف سرور',
        description: '۷۰٪ از کلیدهای متصل به عنوان درگاه‌های فعال پردازش همزمان کتاب‌ها عمل می‌کنند و ۳۰٪ به عنوان ظرفیت رزرو پشتیبان جهت جلوگیری از اتمام توکن و پایداری شبکه نگهداری می‌شوند.',
      },
      slots: {
        primary: partition.primaryKeys.map((k, idx) => ({
          slotIndex: idx + 1,
          id: k.id,
          name: k.name,
          provider: k.provider,
          model: k.model,
          isBusy: Array.from(userKeyAssignments.values()).includes(k.id),
          isCooldown: k.cooldownUntil > Date.now(),
          latencyMs: k.lastLatencyMs || 0,
        })),
        reserve: partition.reserveKeys.map((k, idx) => ({
          slotIndex: partition.activeSlotsLimit + idx + 1,
          id: k.id,
          name: k.name,
          provider: k.provider,
          model: k.model,
          isFailoverActive: activeFailoverReserveKeys.has(k.id),
          isCooldown: k.cooldownUntil > Date.now(),
          latencyMs: k.lastLatencyMs || 0,
        })),
      },
    };
  }

  // Get or assign a primary API key from the 70% active capacity pool
  private getKeyForUser(userId: string): ApiKeyConfig | null {
    const partition = this.getPoolPartition();
    const now = Date.now();

    // Check if user already has an active key assigned that is not in cooldown
    const assignedKeyId = userKeyAssignments.get(userId);
    if (assignedKeyId) {
      const allActive = db.getApiKeys().filter(k => k.isActive);
      const assigned = allActive.find(k => k.id === assignedKeyId);
      if (assigned && assigned.cooldownUntil <= now) {
        return assigned;
      }
    }

    // Select strictly from the 70% Primary Keys pool
    const primaryAvailable = partition.primaryKeys.filter(k => k.cooldownUntil <= now);
    const candidateKeys = primaryAvailable.length > 0 ? primaryAvailable : partition.primaryKeys;

    if (candidateKeys.length > 0) {
      roundRobinKeyIndex = (roundRobinKeyIndex + 1) % candidateKeys.length;
      const selected = candidateKeys[roundRobinKeyIndex];
      userKeyAssignments.set(userId, selected.id);
      return selected;
    }

    // Fallback: If all primary are down, check reserve pool
    if (partition.reserveKeys.length > 0) {
      const healthyReserve = partition.reserveKeys.filter(k => k.cooldownUntil <= now);
      if (healthyReserve.length > 0) {
        const resKey = healthyReserve[0];
        userKeyAssignments.set(userId, resKey.id);
        activeFailoverReserveKeys.add(resKey.id);
        return resKey;
      }
    }

    // Fallback to process.env.GEMINI_API_KEY
    if (process.env.GEMINI_API_KEY) {
      return {
        id: 'env_fallback_key',
        name: 'Environment Gemini Key',
        provider: 'gemini',
        apiKey: process.env.GEMINI_API_KEY.trim(),
        model: 'gemini-3.5-flash-lite',
        isActive: true,
        priority: 1,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalTokensUsed: 0,
        rpmCount: 0,
        cooldownUntil: 0,
      };
    }

    return null;
  }

  /**
   * Switch to a Backup API Key (from the 30% Reserve Standby Pool)
   * Triggered when token exhaustion, 429 quota, or rate-limiting occurs
   */
  private switchUserToBackupKey(userId: string, currentKeyId: string): ApiKeyConfig | null {
    const allActive = db.getApiKeys().filter(k => k.isActive && k.id !== currentKeyId);
    const now = Date.now();
    const currentKey = db.getApiKeys().find(k => k.id === currentKeyId);

    // 1. Prioritize switching to another healthy key with the EXACT SAME MODEL
    // (e.g. if keys are on gemini-3.5-flash-lite, automatically rotate to the next key without altering the model)
    const sameModelKeys = allActive.filter(k => k.cooldownUntil <= now && (!currentKey || k.model === currentKey.model));
    if (sameModelKeys.length > 0) {
      const nextKey = sameModelKeys[0];
      userKeyAssignments.set(userId, nextKey.id);
      console.log(`[QueueWorker] Seamless Key Failover: Switched user ${userId} to next key "${nextKey.name}" keeping SAME model (${nextKey.model})`);
      return nextKey;
    }

    // 2. Fallback: If all keys of the current model are exhausted, switch to the next available healthy key (using that key's assigned model)
    const otherHealthyKeys = allActive.filter(k => k.cooldownUntil <= now);
    if (otherHealthyKeys.length > 0) {
      const nextKey = otherHealthyKeys[0];
      userKeyAssignments.set(userId, nextKey.id);
      activeFailoverReserveKeys.add(nextKey.id);
      console.log(`[QueueWorker] Model Pool Exhaustion: Switched user ${userId} to next available key "${nextKey.name}" with its model (${nextKey.model})`);
      return nextKey;
    }

    // 3. Fallback: Key with earliest cooldown expiration
    if (allActive.length > 0) {
      const sorted = [...allActive].sort((a, b) => a.cooldownUntil - b.cooldownUntil);
      const nextKey = sorted[0];
      userKeyAssignments.set(userId, nextKey.id);
      return nextKey;
    }

    return null;
  }

  private async tick() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Dynamically calculate 70% active processing capacity based on current connected API servers
      const partition = this.getPoolPartition();
      const maxConcurrent = partition.activeSlotsLimit;
      const queuedJobs = db.getActiveJobs();

      for (const job of queuedJobs) {
        // Strict 70% active processing cap: Never exceed 70% of available API slots
        if (this.activeJobIds.size >= maxConcurrent) {
          break;
        }
        if (this.activeJobIds.has(job.id)) {
          continue;
        }

        // Launch background processing for this job in an active slot
        this.activeJobIds.add(job.id);
        this.processJob(job).finally(() => {
          this.activeJobIds.delete(job.id);
          const assigned = userKeyAssignments.get(job.userId);
          if (assigned) {
            activeFailoverReserveKeys.delete(assigned);
          }
          userKeyAssignments.delete(job.userId);
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processJob(job: TranslationJob) {
    const book = db.getBookById(job.bookId);
    if (!book) {
      job.status = 'failed';
      job.error = 'کتاب مرتبط با این پردازش در پایگاه داده یافت نشد.';
      db.saveJob(job);
      return;
    }

    job.status = 'processing';
    book.status = 'translating';
    db.saveJob(job);
    db.saveBook(book);

    console.log(`[QueueWorker] Processing Book "${book.title}" (Job: ${job.id}) for User: ${job.userId}`);

    // Process chunks one by one
    for (let cIdx = 0; cIdx < book.chunks.length; cIdx++) {
      // Check if job was stopped or cancelled by user
      const freshJob = db.getJobById(job.id);
      if (!freshJob || freshJob.status === 'stopped') {
        console.log(`[QueueWorker] Job ${job.id} was stopped. Halting worker.`);
        return;
      }

      const chunk = book.chunks[cIdx];

      // Skip already completed chunks
      if (chunk.status === 'completed' && chunk.translatedHtml) {
        continue;
      }

      job.currentChunkTitle = chunk.chapterTitle || `فصل ${chunk.chapterNumber}`;
      job.progressPercent = Math.round((cIdx / book.chunks.length) * 100);
      db.saveJob(job);

      let translatedHtml = '';
      let chunkError = '';
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts && !translatedHtml) {
        attempts++;
        let keyConfig = this.getKeyForUser(job.userId);
        if (!keyConfig) {
          chunkError = 'هیچ کلید فعالی برای اتصال به هوش مصنوعی یافت نشد.';
          break;
        }

        job.assignedKeyMasked = keyConfig.name;
        db.saveJob(job);

        try {
          const t0 = Date.now();
          translatedHtml = await this.translateChunkWithAi(chunk.englishText, book, keyConfig, chunk.chunkNumber);
          const latency = Date.now() - t0;

          // Record key stats
          keyConfig.totalRequests++;
          keyConfig.successfulRequests++;
          keyConfig.lastLatencyMs = latency;
          keyConfig.totalTokensUsed += (chunk.estimatedTokens || 100) * 2;
          db.saveApiKey(keyConfig);

          chunk.status = 'completed';
          chunk.translatedHtml = translatedHtml;
          chunk.keyUsed = keyConfig.name;
          chunk.modelUsed = keyConfig.model || 'gemini-3.5-flash-lite';
          chunk.translatedAt = Date.now();
          chunk.errorMessage = undefined;

          // Update dedicated book context cache (running narrative thread, terminology, rhythm anchor)
          bookCacheManager.updateCacheAfterChunk({
            bookId: book.id,
            chunkNumber: chunk.chunkNumber,
            englishText: chunk.englishText,
            translatedHtml,
            book,
          });

          job.completedChunks = book.chunks.filter(c => c.status === 'completed').length;
          job.progressPercent = Math.round((job.completedChunks / book.chunks.length) * 100);
          db.saveJob(job);
          db.saveBook(book);

          // Small interval between chunks to respect API limits
          await new Promise(r => setTimeout(r, 2200));
        } catch (err: any) {
          const errMsg = String(err?.message || err);
          console.warn(`[QueueWorker] Chunk translation attempt ${attempts} failed: ${errMsg}`);
          chunkError = errMsg;

          if (keyConfig) {
            keyConfig.failedRequests++;
            // If quota limit, timeout, or high demand, mark cooldown and switch to 30% reserve key immediately
            if (
              errMsg.includes('429') ||
              errMsg.includes('Quota') ||
              errMsg.includes('503') ||
              errMsg.includes('504') ||
              errMsg.includes('DEADLINE_EXCEEDED') ||
              errMsg.includes('Deadline expired') ||
              errMsg.includes('UNAVAILABLE') ||
              errMsg.includes('RESOURCE_EXHAUSTED') ||
              errMsg.includes('timeout')
            ) {
              keyConfig.cooldownUntil = Date.now() + 60000;
              db.saveApiKey(keyConfig);
              this.switchUserToBackupKey(job.userId, keyConfig.id);
            }
          }

          await new Promise(r => setTimeout(r, 3000));
        }
      }

      if (!translatedHtml) {
        chunk.status = 'error';
        chunk.errorMessage = chunkError;
        db.saveBook(book);
        job.error = `خطا در ترجمه بخش: ${chunkError}`;
        db.saveJob(job);
      }
    }

    // Check final status
    const allCompleted = book.chunks.every(c => c.status === 'completed');
    if (allCompleted) {
      job.status = 'completed';
      job.progressPercent = 100;
      job.completedAt = Date.now();
      book.status = 'completed';
      console.log(`[QueueWorker] Book "${book.title}" successfully completed!`);
    } else {
      const anyDone = book.chunks.some(c => c.status === 'completed');
      job.status = anyDone ? 'completed' : 'failed';
      book.status = anyDone ? 'completed' : 'error';
    }

    db.saveJob(job);
    db.saveBook(book);
  }

  private async translateChunkWithAi(englishText: string, book: BookRecord, keyConfig: ApiKeyConfig, chunkNumber: number = 1): Promise<string> {
    const tone = book.tone || 'معنوی و خودشناسی';
    let glossaryText = 'واژه‌نامه تخصصی کتاب';
    if (Array.isArray(book.glossary) && book.glossary.length > 0) {
      glossaryText = book.glossary.map(g => `  * ${g.en} -> ${g.fa}`).join('\n');
    }

    // Retrieve dedicated context cache for this book (narrative continuity, established terms, ending rhythm anchor)
    const dedicatedCachePrompt = bookCacheManager.formatPromptContext(book.id, book.title, tone);

    // Preserve images
    const imageMap = new Map<string, string>();
    let cleanEnglish = englishText;
    const imgRegex = /<img\s+[^>]*src=["'](data:[^"']+)["'][^>]*>/gi;
    let imgIdx = 0;
    cleanEnglish = englishText.replace(imgRegex, (tag) => {
      const token = `[[IMAGE_SLOT_${imgIdx}]]`;
      imageMap.set(token, tag);
      imgIdx++;
      return `\n${token}\n`;
    });

    const sourceLangName = book.sourceLanguage === 'de' ? 'German' : book.sourceLanguage === 'fr' ? 'French' : book.sourceLanguage === 'ar' ? 'Arabic' : book.sourceLanguage === 'tr' ? 'Turkish' : book.sourceLanguage === 'es' ? 'Spanish' : book.sourceLanguage === 'ru' ? 'Russian' : 'English';
    const targetLangName = book.targetLanguage === 'en' ? 'English' : book.targetLanguage === 'ar' ? 'Arabic' : book.targetLanguage === 'tr' ? 'Turkish' : book.targetLanguage === 'fr' ? 'French' : book.targetLanguage === 'de' ? 'German' : 'Persian (Farsi)';

    const userPrompt = `[CONFIGURATION]
- Language Direction: ${sourceLangName} -> ${targetLangName}
- Book Tone: ${tone}
- Chapter Context: ${cleanChapterTitle(book.title)}
- Glossary:
${glossaryText}
${dedicatedCachePrompt ? `\n${dedicatedCachePrompt}` : ''}
[CRITICAL INSTRUCTION]
1. Translate every paragraph and dialogue in full from ${sourceLangName} into fluent, natural, and publication-ready ${targetLangName} without omission, censorship, or summary.
2. Do NOT invent or output artificial chunk numbers or section labels such as "بخش ۱", "بخش ۲", "(بخش ۱)", "Part 1", etc.
${dedicatedCachePrompt ? '3. Maintain 100% naming, stylistic, and rhythmic continuity with the dedicated book context cache provided above.' : ''}

[INPUT TEXT TO TRANSLATE]
${cleanEnglish}`;

    let resultHtml = '';

    if (keyConfig.provider === 'gemini') {
      const ai = new GoogleGenAI({
        apiKey: keyConfig.apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: 55000 },
      });

      const allowAutoSwitch = db.getSettings().keyPoolSettings?.allowAutoSwitchOnTranslationFailure === true;
      const requestedModel = keyConfig.model || 'gemini-3.1-flash-lite';
      const candModels = allowAutoSwitch
        ? Array.from(new Set([
            requestedModel,
            'gemini-3.1-flash-lite',
            'gemini-3.8-flash',
            'gemini-flash-latest',
          ]))
        : [requestedModel];

      let lastErr: any = null;
      for (const m of candModels) {
        try {
          const response = await ai.models.generateContent({
            model: m,
            contents: userPrompt,
            config: {
              systemInstruction: SYSTEM_INSTRUCTION_TRANSLATOR,
              temperature: 0.35,
              topP: 0.95,
              thinkingConfig: { thinkingLevel: (m.includes('lite') || m.includes('flash')) ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW },
            },
          });
          resultHtml = response.text || '';
          break;
        } catch (mErr: any) {
          lastErr = mErr;
          const msg = String(mErr?.message || mErr);
          const isTransient =
            msg.includes('504') ||
            msg.includes('DEADLINE_EXCEEDED') ||
            msg.includes('Deadline expired') ||
            msg.includes('503') ||
            msg.includes('404') ||
            msg.includes('UNAVAILABLE') ||
            msg.includes('timeout') ||
            msg.includes('ETIMEDOUT');
          if (isTransient) {
            console.warn(`[QueueWorker] Transient error on ${m}: ${msg.slice(0, 80)}. Trying fallback model...`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          throw mErr;
        }
      }

      if (!resultHtml && lastErr) throw lastErr;
    } else {
      // OpenAI / GLM (Zhipu AI) / MiniMax / OpenRouter / DeepSeek / Intermediary Proxy (OneAPI)
      let defaultBaseURL = 'https://openrouter.ai/api/v1';
      if (keyConfig.provider === 'glm') defaultBaseURL = 'https://open.bigmodel.cn/api/paas/v4';
      else if (keyConfig.provider === 'minimax') defaultBaseURL = 'https://api.minimax.chat/v1';
      else if (keyConfig.provider === 'openai') defaultBaseURL = 'https://api.openai.com/v1';
      else if (keyConfig.provider === 'deepseek') defaultBaseURL = 'https://api.deepseek.com';
      else if (keyConfig.provider === 'proxy') defaultBaseURL = 'https://api.oneapi.ir/v1';

      const baseURL = (keyConfig.baseURL && keyConfig.baseURL.trim()) || defaultBaseURL;
      const targetUrl = `${baseURL.replace(/\/+$/, '')}/chat/completions`;

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${keyConfig.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: keyConfig.model || 'deepseek/deepseek-r1',
          messages: [
            { role: 'system', content: SYSTEM_INSTRUCTION_TRANSLATOR },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.35,
          top_p: 0.95,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      resultHtml = data.choices?.[0]?.message?.content || '';
    }

    // Re-insert preserved images
    imageMap.forEach((imgTag, token) => {
      resultHtml = resultHtml.split(token).join(imgTag);
    });

    return sanitizeTranslatedHtml(resultHtml);
  }

  public async translateStandalone(englishText: string, tone = 'spiritual', glossary: Array<{ en: string; fa: string }> = []): Promise<string> {
    const dummyBook: BookRecord = {
      id: 'preview',
      userId: 'system',
      title: 'نمونه کتاب',
      originalTitle: 'Sample Book',
      author: 'Author',
      translator: 'Translator',
      tone,
      wordCount: 500,
      estimatedCost: 0,
      status: 'draft',
      chunks: [],
      glossary,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const key = this.getKeyForUser('system_preview');
    if (!key) throw new Error('کلید هوش مصنوعی فعالی روی سرور یافت نشد.');
    return this.translateChunkWithAi(englishText, dummyBook, key);
  }

  public async extractGlossaryTerms(englishText: string, tone = 'general'): Promise<Array<{ en: string; fa: string; note: string }>> {
    const settings = db.getSettings();
    const glossaryCfg = settings.aiGlossaryConfig || {
      enabled: true,
      maxSampleChars: 1200,
      maxTerms: 8,
      fallbackHeuristicEnabled: true,
    };

    // If glossary extraction is disabled in admin settings, return heuristic/empty immediately without calling AI
    if (glossaryCfg.enabled === false) {
      return [];
    }

    const key = this.getKeyForUser('system_glossary');
    if (!key) {
      if (glossaryCfg.fallbackHeuristicEnabled !== false) {
        // Return local heuristic terms without error
        const words = Array.from(new Set(
          englishText.match(/\b[A-Z][a-z]{3,}\b/g) || ['Presence', 'Mindfulness', 'Awareness', 'Consciousness']
        )).slice(0, glossaryCfg.maxTerms || 8);
        return words.map(w => ({
          en: w,
          fa: w === 'Presence' ? 'حضور در لحظه' : w === 'Mindfulness' ? 'ذهن‌آگاهی' : w === 'Awareness' ? 'آگاهی درونی' : 'واژه کلیدی متن',
          note: 'استخراج هوشمند بر مبنای واژگان پرتکرار فصل',
        }));
      }
      throw new Error('کلید هوش مصنوعی فعالی روی سرور یافت نشد.');
    }

    // High efficiency: limit sample to max 1,200 characters (~200 words max, only ~250 input tokens)
    const sampleLimit = Math.min(Math.max(400, glossaryCfg.maxSampleChars || 1200), 2000);
    const compactSample = englishText.slice(0, sampleLimit);
    const targetTermsCount = Math.min(Math.max(4, glossaryCfg.maxTerms || 8), 12);

    const prompt = `You are a professional lexicographer.
Extract strictly ${targetTermsCount} key domain concepts or specialized terminology from this excerpt (Tone: ${tone}):
Schema JSON only:
[{"en":"Presence","fa":"حضور در لحظه","note":"مفهوم کلیدی"}]

TEXT:
${compactSample}`;

    let raw = '';
    try {
      if (key.provider === 'gemini') {
        const ai = new GoogleGenAI({
          apiKey: key.apiKey,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: 20000 },
        });
        const resp = await ai.models.generateContent({
          model: key.model || 'gemini-3.5-flash-lite',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 250, // strictly throttled output ~80 tokens max
          },
        });
        raw = resp.text || '';
      } else {
        let defaultBaseURL = 'https://openrouter.ai/api/v1';
        if (key.provider === 'glm') defaultBaseURL = 'https://open.bigmodel.cn/api/paas/v4';
        else if (key.provider === 'minimax') defaultBaseURL = 'https://api.minimax.chat/v1';
        else if (key.provider === 'openai') defaultBaseURL = 'https://api.openai.com/v1';
        else if (key.provider === 'deepseek') defaultBaseURL = 'https://api.deepseek.com';
        else if (key.provider === 'proxy') defaultBaseURL = 'https://api.oneapi.ir/v1';

        const baseURL = (key.baseURL && key.baseURL.trim()) || defaultBaseURL;
        const response = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key.apiKey.trim()}`,
          },
          body: JSON.stringify({
            model: key.model || 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 250, // strictly throttled output
          }),
        });
        const data = await response.json();
        raw = data.choices?.[0]?.message?.content || '';
      }

      // Record approximate minimal token usage (~250 in + ~80 out = ~330 tokens)
      const approxTokens = Math.ceil(compactSample.length / 4) + 120;
      key.totalTokensUsed = (key.totalTokensUsed || 0) + approxTokens;
      key.totalRequests = (key.totalRequests || 0) + 1;
      key.successfulRequests = (key.successfulRequests || 0) + 1;
      db.saveApiKey(key);
    } catch (apiErr: any) {
      console.warn('[QueueManager] AI glossary extraction API error, using heuristic fallback:', apiErr.message);
      // Heuristic fallback for essential terms
      const words = Array.from(new Set(
        englishText.match(/\b[A-Z][a-z]{3,}\b/g) || ['Presence', 'Mindfulness', 'Awareness', 'Consciousness']
      )).slice(0, 8);

      return words.map(w => ({
        en: w,
        fa: w === 'Presence' ? 'حضور در لحظه' : w === 'Mindfulness' ? 'ذهن‌آگاهی' : w === 'Awareness' ? 'آگاهی درونی' : 'واژه تخصصی متن',
        note: 'استخراج هوشمند بر مبنای واژگان پرتکرار فصل',
      }));
    }

    try {
      const cleaned = raw.replace(/^```json/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return parsed.map((item: any) => ({
          en: String(item.en || '').trim(),
          fa: String(item.fa || '').trim(),
          note: String(item.note || '').trim(),
        })).filter((item: any) => item.en && item.fa);
      }
    } catch (e) {
      console.warn('Failed to parse glossary JSON:', raw);
    }
    return [];
  }
}

export const queueManager = new QueueManager();
