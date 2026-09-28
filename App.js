import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StatusBar, Animated, Easing, ScrollView, Platform, TextInput } from 'react-native';

// ============================================================
// The Groq API key is NOT stored in this code. You paste it once inside
// the app (key screen on first launch, or the key icon on Home) and it
// is saved only in this device's browser storage.
// ============================================================
function getApiKey() {
try {
if (typeof window === 'undefined' || !window.localStorage) return '';
return window.localStorage.getItem('talkflow_groq_key') || '';
} catch (e) { return ''; }
}
function saveApiKey(k) {
try {
const v = (k || '').trim();
if (!v || typeof window === 'undefined' || !window.localStorage) return false;
window.localStorage.setItem('talkflow_groq_key', v);
return true;
} catch (e) { return false; }
}

// Records a full spoken answer, sends it to Groq's Whisper endpoint, and
// returns a clean, punctuated transcript. Whisper needs the whole audio
// clip (not a live stream), so this only runs after recording stops.
async function transcribeWithWhisper(audioBlob) {
if (!getApiKey() || getApiKey().indexOf('PASTE-YOUR') !== -1) {
return { text: null, error: 'No API key has been pasted in yet.' };
}
try {
const formData = new FormData();
formData.append('file', audioBlob, 'speech.webm');
formData.append('model', 'whisper-large-v3');
formData.append('language', 'en');
formData.append('response_format', 'text');
// Bias the model toward common conversational fillers/topics so it
// transcribes them instead of guessing a "cleaner" different word.
formData.append('prompt', 'Um, uh, like, so, you know. Casual spoken English about everyday topics.');

const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
method: 'POST',
headers: {
'Authorization': 'Bearer ' + getApiKey(),
// NOTE: do not set 'content-type' here -- the browser must set its
// own multipart/form-data boundary for FormData to upload correctly.
},
body: formData,
});
if (!response.ok) {
const errText = await response.text();
return { text: null, error: 'HTTP ' + response.status + ': ' + errText.slice(0, 300) };
}
const text = await response.text();
return { text: text.trim(), error: null };
} catch (e) {
return { text: null, error: 'Request failed: ' + e.message };
}
}

async function generateAINaturalVersion(transcriptText) {
if (!getApiKey() || getApiKey().indexOf('PASTE-YOUR') !== -1) {
return { text: null, error: 'No API key has been pasted in yet.' };
}
try {
const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
method: 'POST',
headers: {
'content-type': 'application/json',
'Authorization': 'Bearer ' + getApiKey(),
},
body: JSON.stringify({
model: 'openai/gpt-oss-120b',
// gpt-oss-120b is a "reasoning" model: it spends part of its token
// budget on a hidden reasoning pass before writing the real answer.
// 300 was too low -- it used the whole budget reasoning and never
// got to write anything into `content`, which the old code then
// misread as "unexpected response shape". reasoning_effort keeps
// that hidden pass short, and a bigger budget leaves room for both.
reasoning_effort: 'low',
max_completion_tokens: 700,
messages: [
{
role: 'user',
content: 'Rewrite the following spoken answer into a single natural, fluent, grammatically correct version, the way a thoughtful native speaker would actually say it out loud.\n\nRemove ONLY real disfluencies: filler words (um, uh, like used as a filler), false starts, self-corrections, and word/phrase repetitions (e.g. "I would... I would probably..." becomes "I would probably...").\n\nDo not remove or replace ordinary words just because they are simple or common.\n\nUnderstand the MEANING of phrases, not just individual words -- e.g. "school things" means the user\'s school supplies/belongings, not the school itself; never truncate or literalize an idiom like that.\n\nPreserve the user\'s actual ideas, opinions, and personal voice exactly. Do not invent new information, examples, or ideas that were not said. Do not change what they meant just to make it sound more impressive.\n\nReturn ONLY the rewritten answer, nothing else -- no preamble, no notes.\n\nSpoken answer:\n' + transcriptText,
},
],
}),
});
const data = await response.json();
if (!response.ok) {
return { text: null, error: 'HTTP ' + response.status + ': ' + JSON.stringify(data).slice(0, 300) };
}
const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
if (content && content.trim().length > 0) {
return { text: content.trim(), error: null };
}
return { text: null, error: 'Model returned an empty response (ran out of tokens before writing an answer). Try again.' };
} catch (e) {
return { text: null, error: 'Request failed: ' + e.message };
}
}

// Pulls out the first {...} JSON object from a model response, in case it
// wrapped the JSON in ```json fences or added stray text despite instructions.
// LLMs generating JSON sometimes emit "smart" curly quotes or a trailing
// comma before a closing bracket -- both are invalid JSON but trivial to
// repair. We try a straight parse first, then one repaired-text attempt,
// before giving up.
function extractJsonObject(raw) {
const start = raw.indexOf('{');
const end = raw.lastIndexOf('}');
if (start === -1 || end === -1 || end <= start) return null;
const slice = raw.slice(start, end + 1);
try {
return JSON.parse(slice);
} catch (e) {
try {
const repaired = slice
.replace(/[\u201C\u201D]/g, '"')
.replace(/[\u2018\u2019]/g, "'")
.replace(/,(\s*[}\]])/g, '$1');
return JSON.parse(repaired);
} catch (e2) {
return null;
}
}
}

// Anti-hallucination guard: only accept an AI-quoted line if it (loosely)
// actually appears in the real transcript. Whisper output and the model's
// own quoting can differ by punctuation/case, so we compare normalized,
// punctuation-stripped text rather than requiring an exact match.
function normalizeForMatch(s) {
return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function isGroundedInTranscript(quote, transcriptNorm) {
const q = normalizeForMatch(quote);
return q.length > 0 && transcriptNorm.indexOf(q) !== -1;
}

// The real "AI Analysis" call. Everything here must be judged from the
// actual transcript -- the prompt is written so the model treats the
// transcript as ground truth, never invents content, and explicitly
// recognizes an incomplete/struggling answer instead of pretending it was
// a full explanation. Objective facts (word count, WPM, duration) are
// computed locally and handed in, so the model never has to guess them.
async function generateFullAIAnalysis(transcriptText, topic, facts) {
if (!getApiKey() || getApiKey().indexOf('PASTE-YOUR') !== -1) {
return { data: null, error: 'No API key has been pasted in yet.' };
}
const prompt = 'You are analyzing one spoken English-practice answer. Treat the TRANSCRIPT as the ONLY source of truth -- never invent words, ideas, achievements, or emotions the speaker did not actually say. If the answer is vague, incomplete, or the speaker seems to struggle to explain themselves, do NOT pretend it was a complete explanation -- say so and coach them instead.\n\n'
+ 'TOPIC: ' + topic + '\n'
+ 'TRANSCRIPT (exact words spoken, may be imperfect grammar): ' + transcriptText + '\n'
+ 'KNOWN FACTS (use these exact numbers if you mention stats, do not recompute): word count=' + facts.wordCount + ', duration=' + Math.round(facts.durationSec) + 's, pace=' + facts.wpm + ' WPM\n\n'
+ 'Return ONLY a single valid JSON object (no markdown fences, no commentary) with EXACTLY this shape:\n'
+ '{\n'
+ ' "whatIMeant": string or null -- only if the literal words are a bit unclear/broken but the intended meaning is reasonably inferable; paraphrase that inferred meaning in plain English; use null if the transcript is already clear or the meaning genuinely cannot be inferred,\n'
+ ' "structure": { "opening": string, "mainPoint": string, "detail": string, "conclusion": string } -- each value is the actual portion of the TRANSCRIPT (light cleanup ok) that plays that role; base this on what each part of the speech is actually doing, not just its position,\n'
+ ' "idealStructure": array of 3-4 short strings -- structure suggestions tailored specifically to THIS answer and topic, not generic advice,\n'
+ ' "strongestLine": string -- copy one sentence EXACTLY as spoken (verbatim from the transcript) that is genuinely well-formed and effective; must be an exact substring of the transcript,\n'
+ ' "tightenThis": array of up to 3 objects, each { "original": string (exact substring of the transcript), "corrected": string (grammar-corrected only), "moreFluent": string (a genuinely more natural spoken-English phrasing), "noChangeNeeded": boolean }. Only include a sentence if there is something real to improve, OR set noChangeNeeded=true with corrected/moreFluent equal to original if a sentence is already natural. Never force a fake rewrite just to fill the array,\n'
+ ' "powerWords": array of up to 5 objects { "word": string, "why": string } -- ONLY words/short phrases that literally appear in the transcript and that were genuinely effective in context; do not use a fixed vocabulary list, judge from context,\n'
+ ' "weakWords": array of up to 5 objects { "word": string, "why": string } -- ONLY words/phrases that literally appear in the transcript AND are genuinely weak in THIS context (vague, unnecessarily repeated, or a clearly better word exists). Common words like "so", "like", "actually", "just", "things" must NOT be listed automatically -- only list them if their specific use here is actually weak, and explain why in "why",\n'
+ ' "grammarFeedback": array of up to 3 objects { "mistake": string (short quote of what was actually said), "pattern": string (the general reusable grammar pattern/rule), "explanation": string (plain-English explanation) } -- pick the most useful mistakes, not every tiny one,\n'
+ ' "coaching": null, OR if the speaker struggled to explain their idea / gave an incomplete or very thin answer: { "whatsMissing": string, "howToExpand": string, "exampleAnswer": string (a full example answer to THIS topic, for reference only -- do not imply the speaker said this), "reusablePattern": string (a reusable speaking pattern/template they can apply next time) },\n'
+ ' "scores": { "clarity": number 0-100, "confidence": number 0-100, "grammar": number 0-100 } -- your holistic judgment based on the actual transcript\n'
+ '}\n\n'
+ 'IMPORTANT: output must be valid JSON. Do not wrap quoted excerpts in extra quotation marks inside a string value (the value is already a string) -- e.g. write "mistake": "I dont know" not "mistake": "\\"I dont know\\"".';
try {
const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
method: 'POST',
headers: {
'content-type': 'application/json',
'Authorization': 'Bearer ' + getApiKey(),
},
body: JSON.stringify({
model: 'openai/gpt-oss-120b',
reasoning_effort: 'low',
max_completion_tokens: 2500,
messages: [{ role: 'user', content: prompt }],
}),
});
const data = await response.json();
if (!response.ok) {
return { data: null, error: 'HTTP ' + response.status + ': ' + JSON.stringify(data).slice(0, 300) };
}
const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
if (!content || !content.trim().length) {
return { data: null, error: 'Model returned an empty response (ran out of tokens before writing an answer).' };
}
const parsed = extractJsonObject(content);
if (!parsed) {
return { data: null, error: 'Could not parse the model\'s JSON response. Raw start: ' + content.slice(0, 200) };
}

// Sanitize: drop anything the model claims is a quote but that isn't
// actually, verifiably in the transcript. Better to show nothing than
// to show something the user never said.
const transcriptNorm = normalizeForMatch(transcriptText);

if (parsed.strongestLine && !isGroundedInTranscript(parsed.strongestLine, transcriptNorm)) {
parsed.strongestLine = null;
}
if (Array.isArray(parsed.tightenThis)) {
parsed.tightenThis = parsed.tightenThis.filter((t) => t && t.original && isGroundedInTranscript(t.original, transcriptNorm));
} else {
parsed.tightenThis = [];
}
if (Array.isArray(parsed.powerWords)) {
parsed.powerWords = parsed.powerWords.filter((p) => p && p.word && isGroundedInTranscript(p.word, transcriptNorm));
} else {
parsed.powerWords = [];
}
if (Array.isArray(parsed.weakWords)) {
parsed.weakWords = parsed.weakWords.filter((w) => w && w.word && isGroundedInTranscript(w.word, transcriptNorm));
} else {
parsed.weakWords = [];
}
if (!Array.isArray(parsed.grammarFeedback)) parsed.grammarFeedback = [];
if (!Array.isArray(parsed.idealStructure)) parsed.idealStructure = [];

return { data: parsed, error: null };
} catch (e) {
return { data: null, error: 'Request failed: ' + e.message };
}
}

if (Platform.OS === 'web' && typeof document !== 'undefined') {
const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 380">'
+ '<rect x="0" y="0" width="380" height="380" rx="80" fill="#0D0705"/>'
+ '<path d="M190,70 Q230,175 330,190 Q230,205 190,310 Q150,205 50,190 Q150,175 190,70 Z" fill="#FF4500"/>'
+ '<rect x="178" y="150" width="7" height="80" rx="3.5" fill="#0D0705"/>'
+ '<rect x="196" y="130" width="7" height="120" rx="3.5" fill="#0D0705"/>'
+ '<rect x="214" y="165" width="7" height="50" rx="3.5" fill="#0D0705"/>'
+ '</svg>';
const svgUrl = 'data:image/svg+xml,' + encodeURIComponent(iconSvg);
document.title = 'TalkFlow';

// "Add to Home Screen" icons need a real PNG, not SVG -- browsers just
// fall back to a generic screenshot icon when they get an SVG here. So we
// draw our logo onto an offscreen canvas once, then hand out the
// resulting PNG everywhere an icon is needed (same exact logo, just in a
// format Home Screen actually accepts).
const img = new Image();
img.onload = function () {
const size = 512;
const canvas = document.createElement('canvas');
canvas.width = size;
canvas.height = size;
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0, size, size);
const pngUrl = canvas.toDataURL('image/png');

let favicon = document.querySelector("link[rel~='icon']");
if (!favicon) {
favicon = document.createElement('link');
favicon.rel = 'icon';
document.head.appendChild(favicon);
}
favicon.href = pngUrl;

let touchIcon = document.querySelector("link[rel='apple-touch-icon']");
if (!touchIcon) {
touchIcon = document.createElement('link');
touchIcon.rel = 'apple-touch-icon';
document.head.appendChild(touchIcon);
}
touchIcon.href = pngUrl;

// NOTE: deliberately NOT injecting a Web App Manifest here. A "real"
// standalone-app install needs Android to fetch manifest.json from a
// stable, permanent URL -- but Snack can't host one for us, so a
// blob: URL manifest just breaks the installed icon (it hangs
// forever trying to reach a file that no longer exists). Sticking to
// a plain favicon/apple-touch-icon means "Add to Home Screen" makes a
// normal, reliable shortcut instead -- it opens in a regular Chrome
// tab (address bar visible) rather than full-screen, but it actually
// works every time.
};
img.src = svgUrl;
}

const TOPICS = [
"How did your day go so far?",
"What's something small that made you happy this week?",
"Tell me about something new you tried recently.",
"What did you have for breakfast, and how was it?",
"Describe your morning routine.",
"What's a small problem you solved today?",
"Talk about someone who helped you recently.",
"What are you looking forward to this week?",
"What's your favorite way to relax after a long day?",
"Describe a meal you really enjoyed recently.",
"What's something you learned this week?",
"Talk about a habit you're trying to build.",
"What's the last show or video you watched, and what did you think?",
"Describe your ideal weekend.",
"What's something you're proud of from this week?",
"Talk about a place near you that you like visiting.",
"What's a small change that made your day easier?",
"Describe your commute or how you get around.",
"What's something you want to get better at?",
"Talk about a decision you made recently.",
"What's your favorite season, and why?",
"Describe a conversation you had recently.",
"What's something on your to-do list right now?",
"Talk about a skill you're currently learning.",
"What's a small thing that annoyed you today?",
"Describe how you usually spend your evenings.",
"What's a goal you're working toward?",
"Talk about a friend or family member and what you did together recently.",
"What's something in your daily routine you'd like to change?",
"Describe your favorite type of weather and why.",
"What's an app or tool you use every day?",
"Talk about something that surprised you recently.",
];

const FILLER_WORDS = ['um','uh','like','just','actually','basically','literally','really','so','okay','well','stuff','things','kind','sort'];
const STOPWORDS = ['the','a','an','and','or','but','is','are','was','were','to','of','in','on','at','for','with','my','it','that','this','i','you','we','they','he','she','be','have','has','had','do','does','did','not','if','as','from','by','about'];

// Only real, legitimate words on this list can ever become a "Power Word" --
// this guarantees speech-recognition typos/nonsense (like a mis-heard word)
// can never be mistakenly praised, since made-up text just won't be in here.
// Detects one of the most common ESL grammar mistakes: "am/is/are/was/were"
// directly followed by a bare verb instead of its -ing form (e.g. "I am eat"
// instead of "I am eating"). Chunks matching this are never shown as the
// Strongest Line, since that section should only spotlight solid sentences.
const BASE_VERBS = ['eat','go','take','drink','put','write','read','watch','play','walk','run','talk',
'come','do','make','get','give','see','say','want','need','know','think','feel','look','work','study',
'sleep','wake','drive','visit','buy','sell','open','close','start','finish','clean','cook','wash','call',
'send','build','fix','learn','teach','ride','fly','swim','dance','sing','draw','paint','wear','choose',
'bring','lose','win','pay','spend','meet','leave','arrive','stay','wait','try','help','use'];
const BE_VERBS = ['am','is','are','was','were'];

function hasGrammarFlag(text) {
const words = text.split(/\s+/);
for (let i = 0; i < words.length - 1; i++) {
const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
const next = words[i + 1].toLowerCase().replace(/[^a-z]/g, '');
if (BE_VERBS.indexOf(w) !== -1 && BASE_VERBS.indexOf(next) !== -1) return true;
}
return false;
}

const VERB_ING_MAP = {
eat: 'eating', go: 'going', take: 'taking', drink: 'drinking', put: 'putting', write: 'writing',
read: 'reading', watch: 'watching', play: 'playing', walk: 'walking', run: 'running', talk: 'talking',
come: 'coming', do: 'doing', make: 'making', get: 'getting', give: 'giving', see: 'seeing', say: 'saying',
want: 'wanting', need: 'needing', know: 'knowing', think: 'thinking', feel: 'feeling', look: 'looking',
work: 'working', study: 'studying', sleep: 'sleeping', wake: 'waking', drive: 'driving', visit: 'visiting',
buy: 'buying', sell: 'selling', open: 'opening', close: 'closing', start: 'starting', finish: 'finishing',
clean: 'cleaning', cook: 'cooking', wash: 'washing', call: 'calling', send: 'sending', build: 'building',
fix: 'fixing', learn: 'learning', teach: 'teaching', ride: 'riding', fly: 'flying', swim: 'swimming',
dance: 'dancing', sing: 'singing', draw: 'drawing', paint: 'painting', wear: 'wearing', choose: 'choosing',
bring: 'bringing', lose: 'losing', win: 'winning', pay: 'paying', spend: 'spending', meet: 'meeting',
leave: 'leaving', arrive: 'arriving', stay: 'staying', wait: 'waiting', try: 'trying', help: 'helping', use: 'using',
};

// Fixes the specific "be-verb + bare verb" mistake by converting the bare
// verb to its -ing form (e.g. "I am eat" -> "I am eating"), leaving the rest
// of the sentence exactly as the user said it.
function fixBareVerbMistake(text) {
const words = text.split(/\s+/);
for (let i = 0; i < words.length - 1; i++) {
const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
const nextClean = words[i + 1].toLowerCase().replace(/[^a-z]/g, '');
if (BE_VERBS.indexOf(w) !== -1 && VERB_ING_MAP[nextClean]) {
words[i + 1] = VERB_ING_MAP[nextClean];
return words.join(' ');
}
}
return text;
}

const POWER_WORD_WHITELIST = [
'specifically','significant','effective','efficient','confident','confidence',
'clarity','clearly','essential','essentially','important','importantly',
'productivity','productive','flexibility','flexible','structure','structured',
'organized','strategy','strategic','priority','prioritize','accomplish',
'accomplished','achieve','achieved','improve','improved','improvement',
'progress','opportunity','challenge','challenging','solution','solve',
'solved','responsible','responsibility','experience','experienced',
'perspective','realize','realized','recognize','recognized','genuine',
'genuinely','meaningful','purpose','purposeful','focus','focused',
'consistent','consistency','balance','balanced','routine','discipline',
'motivated','motivation','grateful','gratitude','peaceful','relaxed',
'refreshed','energized','accomplishment','breakthrough','curious',
'curiosity','thoughtful','careful','deliberate','decisive',
'passionate','passion','creative','creativity','innovative','remarkable',
'valuable','worthwhile','fulfilling','satisfying','rewarding',
];

function collapseRepeats(text) {
let words = text.split(/\s+/);
let changed = true;
while (changed) {
changed = false;
for (let n = 4; n >= 1; n--) {
for (let i = 0; i + 2 * n <= words.length; i++) {
const a = words.slice(i, i + n).join(' ').toLowerCase();
const b = words.slice(i + n, i + 2 * n).join(' ').toLowerCase();
if (a === b && a.length > 0) {
words.splice(i + n, n);
changed = true;
break;
}
}
if (changed) break;
}
}
return words.join(' ');
}

function loadRecentTopics() {
try {
if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.localStorage) return [];
const raw = window.localStorage.getItem('talkflow_recent_topics');
return raw ? JSON.parse(raw) : [];
} catch (e) { return []; }
}

function saveRecentTopic(topic) {
try {
if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.localStorage) return;
let recent = loadRecentTopics();
recent.push(topic);
if (recent.length > 10) recent = recent.slice(recent.length - 10);
window.localStorage.setItem('talkflow_recent_topics', JSON.stringify(recent));
} catch (e) {}
}

function pickTopic() {
const recent = loadRecentTopics();
const available = TOPICS.filter((t) => recent.indexOf(t) === -1);
const pool = available.length > 0 ? available : TOPICS;
const chosen = pool[Math.floor(Math.random() * pool.length)];
saveRecentTopic(chosen);
return chosen;
}

function splitIntoChunks(transcriptRaw) {
const punctSentences = transcriptRaw.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
const chunks = [];
punctSentences.forEach((s) => {
const wordCount = s.split(/\s+/).length;
if (wordCount <= 14) {
chunks.push(s);
} else {
// Browser speech recognition rarely adds real punctuation, so a long
// answer often comes through as one giant run-on blob. Break it at
// natural joining words AND at stutter/restart repeats like "I am I am".
const parts = s.split(/\s+(and then|and|then|so|or)\s+|\b(\w+(?:\s+\w+)?)\s+\2\b/i);
let current = '';
for (let i = 0; i < parts.length; i++) {
const part = parts[i];
if (!part) continue;
if (/^(and then|and|then|so|or)$/i.test(part.trim())) continue;
current = (current ? current + ' ' : '') + part;
const currentWords = current.trim().split(/\s+/).length;
if (currentWords >= 4) {
chunks.push(current.trim());
current = '';
}
}
if (current.trim().split(/\s+/).length >= 3) chunks.push(current.trim());
}
});
return chunks.filter((c) => c.split(/\s+/).length >= 3).map((c) => collapseRepeats(c));
}

const IDEAL_STRUCTURE = [
'Clear opening that states your main point',
'Supporting detail or reasoning',
'A specific, concrete example',
'A short conclusion that ties back to the opening',
];

function computeStructure(chunks) {
if (chunks.length === 0) return [];
if (chunks.length === 1) return [{ label: 'Your answer', text: chunks[0] }];
const yours = [{ label: 'Opening', text: chunks[0] }];
if (chunks.length >= 3) {
const midIndex = Math.floor(chunks.length / 2);
yours.push({ label: 'Main point', text: chunks[midIndex] });
}
if (chunks.length >= 4) {
yours.push({ label: 'Detail', text: chunks[chunks.length - 2] });
}
yours.push({ label: 'Conclusion', text: chunks[chunks.length - 1] });
return yours;
}

const PRONOUNS = ['i', 'you', 'we', 'they', 'he', 'she', 'it'];

// Removes filler words, but protects "like" when it's actually the main
// verb (e.g. "I like walking") rather than filler ("it was, like, cool").
function stripFillersSmart(s) {
let fixed = s;
FILLER_WORDS.forEach((f) => {
if (f === 'like') return;
fixed = fixed.replace(new RegExp('\\b' + f + '\\b\\s*', 'gi'), '');
});
fixed = fixed.replace(/\s+/g, ' ').trim();
fixed = fixed.replace(new RegExp('\\b(' + PRONOUNS.join('|') + ')\\s+like\\b', 'gi'), '$1 §LIKEVERB§');
fixed = fixed.replace(/\blike\b\s*/gi, '');
fixed = fixed.replace(/§LIKEVERB§/gi, 'like');
fixed = fixed.replace(/,\s*,/g, ',').replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '');
fixed = fixed.replace(/\s+/g, ' ').trim();
fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
return fixed;
}

function fixAllGrammar(text) {
let fixed = text;
let guard = 0;
while (hasGrammarFlag(fixed) && guard < 10) {
fixed = fixBareVerbMistake(fixed);
guard++;
}
return fixed;
}

// Builds a full cleaned-up version of the whole answer (not just one
// sentence) by applying the same grammar/filler fixes to every chunk.
// Honest limit: this only fixes the specific patterns we detect (verb-form
// mistakes, fillers, stutters) -- it isn't real language understanding, so
// heavily broken speech will still come out rough.
function buildNaturalVersion(chunks) {
const cleaned = chunks
.map((c) => stripFillersSmart(fixAllGrammar(c)))
.filter((c) => c.length > 0);
if (cleaned.length === 0) return '';
return cleaned.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join('. ') + '.';
}

function computeReview(transcriptRaw, durationSec) {
const transcript = transcriptRaw.trim();
const words = transcript.length ? transcript.split(/\s+/) : [];
const wordCount = words.length;
const minutes = Math.max(durationSec / 60, 0.1);
const wpm = Math.round(wordCount / minutes);

let fillerCount = 0;
const fillerFound = {};
words.forEach((w) => {
const clean = w.toLowerCase().replace(/[^a-z']/g, '');
if (FILLER_WORDS.indexOf(clean) !== -1) {
fillerCount++;
fillerFound[clean] = (fillerFound[clean] || 0) + 1;
}
});
const weakWords = Object.keys(fillerFound).sort((a, b) => fillerFound[b] - fillerFound[a]).slice(0, 5);

const powerCandidates = {};
words.forEach((w) => {
const clean = w.toLowerCase().replace(/[^a-z']/g, '');
if (POWER_WORD_WHITELIST.indexOf(clean) !== -1) {
powerCandidates[clean] = (powerCandidates[clean] || 0) + 1;
}
});
const powerWords = Object.keys(powerCandidates).slice(0, 4);

const chunks = splitIntoChunks(transcript);
let strongestLine = '';
let bestScore = -1;
chunks.forEach((c) => {
if (hasGrammarFlag(c)) return; // skip chunks with a detected grammar mistake
const wc = c.split(/\s+/).length;
const score = (wc >= 5 && wc <= 14) ? wc : wc * 0.3;
if (score > bestScore) { bestScore = score; strongestLine = c; }
});
if (!strongestLine && chunks.length > 0) {
// Every chunk had a flagged mistake -- fall back to the longest one
// rather than showing nothing.
let maxLen = 0;
chunks.forEach((c) => {
const wc = c.split(/\s+/).length;
if (wc > maxLen) { maxLen = wc; strongestLine = c; }
});
}
if (!strongestLine && transcript) strongestLine = transcript;

let tightenOriginal = '';
let tightenFixed = '';
let tightenWasGrammarFix = false;

// Prefer a chunk with an actual grammar mistake we can fix -- that's more
// useful to highlight than just removing a filler word.
for (let i = 0; i < chunks.length; i++) {
const s = chunks[i];
if (hasGrammarFlag(s)) {
tightenOriginal = s;
let fixed = fixBareVerbMistake(s);
fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
tightenFixed = fixed;
tightenWasGrammarFix = true;
break;
}
}

// Otherwise fall back to cleaning up a filler-word-heavy chunk.
if (!tightenOriginal) {
for (let i = 0; i < chunks.length; i++) {
const s = chunks[i];
const hasFiller = FILLER_WORDS.some((f) => new RegExp('\\b' + f + '\\b', 'i').test(s));
if (hasFiller) {
tightenOriginal = s;
tightenFixed = stripFillersSmart(s);
break;
}
}
}

// This is only the local fallback (used instantly, before/if the real AI
// analysis responds) -- so if cleanup genuinely changed nothing, say that
// plainly instead of showing two identical blocks of text.
const tightenList = [];
if (tightenOriginal) {
const noChangeNeeded = normalizeForMatch(tightenFixed) === normalizeForMatch(tightenOriginal);
tightenList.push({
original: tightenOriginal,
corrected: tightenWasGrammarFix ? tightenFixed : tightenOriginal,
moreFluent: tightenFixed,
noChangeNeeded,
});
}

let paceLabel = 'Good';
if (wpm < 90) paceLabel = 'Slow';
else if (wpm > 160) paceLabel = 'Fast';
else if (wpm >= 90 && wpm < 110) paceLabel = 'Normal';

const fillerRatio = wordCount > 0 ? fillerCount / wordCount : 0;
const clarity = Math.max(40, Math.min(95, Math.round(95 - fillerRatio * 250)));
const confidence = Math.max(40, Math.min(95, Math.round(90 - fillerRatio * 200 - Math.abs(wpm - 130) * 0.2)));
const grammar = Math.max(50, Math.min(95, Math.round(85 - fillerRatio * 100)));

let summary = 'You spoke ' + wordCount + ' words in about ' + Math.round(durationSec) + ' seconds, at a ' + paceLabel.toLowerCase() + ' pace of ' + wpm + ' WPM.';
if (fillerCount > 0) {
summary += ' You used filler words like "' + weakWords.slice(0, 2).join('", "') + '" ' + fillerCount + ' time' + (fillerCount === 1 ? '' : 's') + ', cutting those would make your answer sound sharper.';
} else if (wordCount > 0) {
summary += ' You spoke cleanly with no repeated filler words, nice control.';
} else {
summary = 'No speech was captured this time. Try speaking a bit louder or closer to the mic.';
}

return {
wordCount, wpm, paceLabel, fillerCount, weakWords, powerWords,
strongestLine, tightenList, clarity, confidence, grammar, summary,
yourStructure: computeStructure(chunks),
idealStructure: null, // filled in by AI analysis when it arrives
whatIMeant: null,
grammarFeedback: [],
coaching: null,
naturalVersion: buildNaturalVersion(chunks),
};
}

function saveSession(session) {
try {
if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.localStorage) return;
const raw = window.localStorage.getItem('talkflow_sessions');
const sessions = raw ? JSON.parse(raw) : [];
sessions.push(session);
window.localStorage.setItem('talkflow_sessions', JSON.stringify(sessions));
} catch (e) {}
}

// The session is saved instantly with the local heuristic scores so
// Weekly Stats never shows a gap while the AI is still thinking. Once the
// real AI analysis comes back (a few seconds later), this patches that
// same saved session in place with the more accurate scores, matched by
// its exact save timestamp.
function updateSessionScores(dateKey, scores) {
try {
if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.localStorage) return;
const raw = window.localStorage.getItem('talkflow_sessions');
const sessions = raw ? JSON.parse(raw) : [];
const idx = sessions.findIndex((s) => s.date === dateKey);
if (idx !== -1) {
sessions[idx] = { ...sessions[idx], ...scores };
window.localStorage.setItem('talkflow_sessions', JSON.stringify(sessions));
}
} catch (e) {}
}

function loadSessions() {
try {
if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.localStorage) return [];
const raw = window.localStorage.getItem('talkflow_sessions');
return raw ? JSON.parse(raw) : [];
} catch (e) { return []; }
}

function clearSessions() {
try {
if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.localStorage) return;
window.localStorage.removeItem('talkflow_sessions');
} catch (e) {}
}

function getTodayKey() {
const d = new Date();
return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function markTodayDone() {
try {
if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.localStorage) return;
window.localStorage.setItem('talkflow_last_completed', getTodayKey());
} catch (e) {}
}

function isTodayDone() {
try {
if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.localStorage) return false;
return window.localStorage.getItem('talkflow_last_completed') === getTodayKey();
} catch (e) { return false; }
}

function computeDailyTrend(sessions) {
const days = [];
const now = new Date();
for (let i = 6; i >= 0; i--) {
const d = new Date(now);
d.setDate(d.getDate() - i);
const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
const label = d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 1);
days.push({ key, label, score: null, count: 0, sum: 0 });
}
sessions.forEach((s) => {
const d = new Date(s.date);
const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
const dayEntry = days.find((x) => x.key === key);
if (dayEntry) {
const overall = (s.clarity + s.confidence + s.grammar) / 3;
dayEntry.sum += overall;
dayEntry.count += 1;
}
});
days.forEach((d) => { if (d.count > 0) d.score = Math.round(d.sum / d.count); });
return days;
}

function computeWeeklyStats(sessions) {
const now = Date.now();
const oneDay = 24 * 60 * 60 * 1000;
const thisWeek = sessions.filter((s) => now - s.date < 7 * oneDay);
const prevWeek = sessions.filter((s) => now - s.date >= 7 * oneDay && now - s.date < 14 * oneDay);

function avg(arr, key) {
if (!arr.length) return null;
let sum = 0;
arr.forEach((s) => { sum += s[key]; });
return sum / arr.length;
}

const metricKeys = ['clarity', 'confidence', 'grammar'];
const result = {};
metricKeys.forEach((m) => {
const cur = avg(thisWeek, m);
const prev = avg(prevWeek, m);
const pct = (cur != null && prev) ? Math.round(((cur - prev) / prev) * 100) : null;
result[m] = { value: cur != null ? Math.round(cur) : null, pct };
});
const curWpm = avg(thisWeek, 'wpm');
result.wpm = curWpm != null ? Math.round(curWpm) : null;

let whatImproved = '';
let focusNext = '';
if (thisWeek.length === 0) {
whatImproved = 'No sessions yet this week. Complete a daily lesson to start tracking trends.';
focusNext = 'Try today\'s lesson to get your first session logged.';
} else {
let best = null;
metricKeys.forEach((m) => {
if (result[m].pct != null && (best === null || result[m].pct > result[best].pct)) best = m;
});
if (best && result[best].pct > 0) {
whatImproved = 'Your ' + best + ' improved ' + result[best].pct + '% compared to last week.';
} else {
whatImproved = 'You logged ' + thisWeek.length + ' session' + (thisWeek.length === 1 ? '' : 's') + ' this week.';
}
let weakest = null;
metricKeys.forEach((m) => {
if (result[m].value != null && (weakest === null || result[m].value < result[weakest].value)) weakest = m;
});
if (weakest) {
focusNext = 'Your ' + weakest + ' score is your lowest this week, that is the best area to focus on next.';
} else {
focusNext = 'Keep practicing daily to build a trend.';
}
}
return { thisWeekCount: thisWeek.length, metrics: result, whatImproved, focusNext, dailyTrend: computeDailyTrend(sessions) };
}

const APP_BUILD = 'v24-groq-model-fix';

const COLORS = {
bg: '#0D0705', card: '#1A1210', border: '#241713', orange: '#FF4500', orangeLight: '#FF6B35',
text: '#F5E6DE', muted: '#7A6E64', green: '#5DCAA5', greenText: '#97C459', red: '#F09595',
weakBg: '#3A241C', weakText: '#D88C7B', powerBg: '#1D3B2C',
};

// Defined OUTSIDE App (top-level) on purpose: this is the fix for the
// keyboard-closing bug. If this were defined inside App's body, a new
// function/component would be created on every keystroke (since typing
// triggers a state update and re-render), and React would treat each one
// as a different component -- unmounting and remounting the actual text
// input underneath it, which is what was closing the keyboard. Keeping it
// as a single stable top-level component with props fixes that at the root.
function EditTranscriptScreen({ value, onChangeText, onConfirm }) {
return (
<View style={styles.screen}>
<Text style={styles.mutedLabel}>CHECK YOUR TRANSCRIPT</Text>
<Text style={[styles.smallMuted, { marginBottom: 14 }]}>Speech recognition isn't perfect — fix any misheard words before we generate your review.</Text>
<TextInput
style={styles.transcriptInput}
value={value}
onChangeText={onChangeText}
multiline
textAlignVertical="top"
autoCorrect={false}
autoCapitalize="none"
spellCheck={false}
placeholder="Your transcript will appear here"
placeholderTextColor={COLORS.muted}
/>
<TouchableOpacity style={styles.primaryButton} activeOpacity={0.8} onPress={onConfirm}>
<Text style={styles.primaryButtonText}>Looks good, continue</Text>
</TouchableOpacity>
</View>
);
}

export default function App() {
const [screen, setScreen] = useState('home');
const [topic, setTopic] = useState('');
const [timeLeft, setTimeLeft] = useState(120);
const [running, setRunning] = useState(false);
const [transcript, setTranscript] = useState('');
const [wpm, setWpm] = useState(0);
const [review, setReview] = useState(null);
const [micError, setMicError] = useState('');
const [weeklyStats, setWeeklyStats] = useState(null);
const [todayDone, setTodayDone] = useState(false);
const [editedTranscript, setEditedTranscript] = useState('');
const [sessionDuration, setSessionDuration] = useState(0);
const [isReEdit, setIsReEdit] = useState(false);
const [aiLoading, setAiLoading] = useState(false);
const [aiError, setAiError] = useState('');
const [analysisLoading, setAnalysisLoading] = useState(false);
const [analysisError, setAnalysisError] = useState('');
const [transcribeError, setTranscribeError] = useState('');
const [needKey, setNeedKey] = useState(() => !getApiKey());
const [keyDraft, setKeyDraft] = useState('');
const spinValue = useRef(new Animated.Value(0)).current;
const startTimeRef = useRef(null);
const streamRef = useRef(null);
const mediaRecorderRef = useRef(null);
const audioChunksRef = useRef([]);

const startLesson = () => {
setScreen('spinning');
setMicError('');
spinValue.setValue(0);
Animated.timing(spinValue, {
toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: true,
}).start(() => {
const random = pickTopic();
setTopic(random);
setTimeLeft(120);
setRunning(false);
setTranscript('');
setTranscribeError('');
setScreen('speaking');
});
};

const rotate = spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '1080deg'] });

// ---- Recording (browser only) ----
// We record the raw audio with the browser's MediaRecorder, then send the
// whole clip to Whisper (via Groq) once the user stops. Whisper needs the
// full clip, not a live stream, so there's no word-by-word live transcript
// anymore -- the screen just shows a "Recording" indicator instead.
const startRecording = async () => {
if (Platform.OS !== 'web') {
setMicError('Voice recording works in the Web preview for now.');
setRunning(true);
startTimeRef.current = Date.now();
return;
}
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
setMicError('This browser doesn\'t support audio recording. Try Chrome.');
return;
}
try {
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
streamRef.current = stream;
const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
audioChunksRef.current = [];

mediaRecorder.ondataavailable = (e) => {
if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
};
mediaRecorder.onstop = () => {
if (streamRef.current) {
streamRef.current.getTracks().forEach((t) => t.stop());
streamRef.current = null;
}
const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
finishRecording(audioBlob);
};

mediaRecorderRef.current = mediaRecorder;
startTimeRef.current = Date.now();
mediaRecorder.start();
setRunning(true);
setMicError('');
} catch (e) {
setMicError('Could not access microphone: ' + e.message);
}
};

const stopRecording = () => {
setRunning(false);
if (Platform.OS !== 'web') {
finishRecording(null);
return;
}
if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
mediaRecorderRef.current.stop(); // triggers onstop -> finishRecording above
} else {
finishRecording(null);
}
};

// Called once we have the full audio clip (or null on native/no audio).
// Sends it to Whisper and only moves to the Edit screen once we have text
// back, so the user never edits a transcript mid-transcription.
const finishRecording = (audioBlob) => {
const durationSec = startTimeRef.current ? (Date.now() - startTimeRef.current) / 1000 : (120 - timeLeft);
setSessionDuration(durationSec);

if (!audioBlob || audioBlob.size < 1000) {
setTranscript('');
setEditedTranscript('');
setScreen('edit');
return;
}

setTranscribeError('');
setScreen('transcribing');
transcribeWithWhisper(audioBlob).then((result) => {
if (result.text) {
setTranscript(result.text);
setEditedTranscript(result.text);
setScreen('edit');
} else {
setTranscribeError(result.error || 'Transcription failed. Please try again.');
setScreen('speaking');
}
});
};

const confirmTranscriptAndReview = () => {
const finalText = editedTranscript.trim();
setTranscript(finalText);
const wordCount = finalText.length ? finalText.split(/\s+/).length : 0;
const minutes = Math.max(sessionDuration / 60, 0.1);
const wpmNow = Math.round(wordCount / minutes);
setWpm(wpmNow);
const computedReview = computeReview(finalText, sessionDuration);
setReview(computedReview);

const sessionDateKey = Date.now();
const willSaveSession = wordCount > 0 && !isReEdit;
if (willSaveSession) {
saveSession({
date: sessionDateKey,
clarity: computedReview.clarity,
confidence: computedReview.confidence,
grammar: computedReview.grammar,
wpm: computedReview.wpm,
});
markTodayDone();
}
setIsReEdit(false);
setScreen('review');

// Neither AI call below ever blocks the screen above -- if no key is set,
// or a request fails for any reason, the free rule-based review (already
// shown) stays exactly as it is right now.
if (wordCount > 0) {
setAiLoading(true);
setAiError('');
generateAINaturalVersion(finalText).then((result) => {
setAiLoading(false);
if (result && result.text) {
setReview((prev) => (prev ? { ...prev, naturalVersion: result.text } : prev));
} else if (result && result.error) {
setAiError(result.error);
}
});

setAnalysisLoading(true);
setAnalysisError('');
generateFullAIAnalysis(finalText, topic, { wordCount, durationSec: sessionDuration, wpm: wpmNow }).then((result) => {
setAnalysisLoading(false);
if (result && result.data) {
const d = result.data;
setReview((prev) => {
if (!prev) return prev;
const next = { ...prev };
if (d.whatIMeant) next.whatIMeant = d.whatIMeant;
if (d.structure && d.structure.opening && d.structure.mainPoint && d.structure.conclusion) {
const parts = [
{ label: 'Opening', text: d.structure.opening },
{ label: 'Main point', text: d.structure.mainPoint },
];
if (d.structure.detail) parts.push({ label: 'Detail', text: d.structure.detail });
parts.push({ label: 'Conclusion', text: d.structure.conclusion });
next.yourStructure = parts;
}
if (d.idealStructure && d.idealStructure.length > 0) next.idealStructure = d.idealStructure;
if (d.strongestLine) next.strongestLine = d.strongestLine;
if (d.tightenThis && d.tightenThis.length > 0) next.tightenList = d.tightenThis;
if (d.powerWords && d.powerWords.length > 0) next.powerWords = d.powerWords.map((p) => p.word);
if (d.weakWords && d.weakWords.length > 0) next.weakWords = d.weakWords.map((w) => w.word);
if (d.grammarFeedback && d.grammarFeedback.length > 0) next.grammarFeedback = d.grammarFeedback;
if (d.coaching) next.coaching = d.coaching;
if (d.scores) {
if (typeof d.scores.clarity === 'number') next.clarity = d.scores.clarity;
if (typeof d.scores.confidence === 'number') next.confidence = d.scores.confidence;
if (typeof d.scores.grammar === 'number') next.grammar = d.scores.grammar;
}
if (willSaveSession && d.scores) {
updateSessionScores(sessionDateKey, {
clarity: typeof d.scores.clarity === 'number' ? d.scores.clarity : prev.clarity,
confidence: typeof d.scores.confidence === 'number' ? d.scores.confidence : prev.confidence,
grammar: typeof d.scores.grammar === 'number' ? d.scores.grammar : prev.grammar,
});
}
return next;
});
} else if (result && result.error) {
setAnalysisError(result.error);
}
});
}
};

const editFromReview = () => {
setEditedTranscript(transcript);
setIsReEdit(true);
setScreen('edit');
};

useEffect(() => {
if (!running) return;
if (timeLeft <= 0) {
stopRecording();
return;
}
const t = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
return () => clearTimeout(t);
}, [running, timeLeft]);

useEffect(() => {
if (screen === 'home') {
setTodayDone(isTodayDone());
}
}, [screen]);

useEffect(() => {
if (screen === 'stats') {
setWeeklyStats(computeWeeklyStats(loadSessions()));
}
}, [screen]);

const formatTime = (s) => {
const m = Math.floor(s / 60);
const sec = s % 60;
const secStr = sec < 10 ? ('0' + sec) : ('' + sec);
return m + ':' + secStr;
};

// ---------- SCREENS ----------

const Home = () => (
<View style={styles.screen}>
<Text style={styles.dateLabel}>TODAY</Text>
<Text style={styles.homeTitle}>{todayDone ? "Today's session complete" : "Ready for today's session"}</Text>
<View style={{ flex: 1 }} />
<View style={styles.circleWrap}>
<View style={styles.circleOutline}>
<Text style={{ fontSize: 32, color: COLORS.orange }}>{todayDone ? '✓' : '✦'}</Text>
</View>
<Text style={styles.circleCaption}>{todayDone ? 'Nice work today. Come back tomorrow, or practice again.' : 'One topic. Two minutes. Every day.'}</Text>
</View>
<TouchableOpacity style={styles.primaryButton} activeOpacity={0.8} onPress={startLesson}>
<Text style={styles.primaryButtonText}>{todayDone ? 'Practice again' : "Start today's lesson"}</Text>
</TouchableOpacity>
<TabBar active="lesson" onStats={() => setScreen('stats')} onLesson={() => setScreen('home')} />
<Text style={{ color: '#2A1F1A', fontSize: 9, textAlign: 'center', marginTop: 8 }}>{APP_BUILD}</Text>
</View>
);

const Spinning = () => (
<View style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}>
<Text style={styles.mutedLabel}>FINDING TODAY'S TOPIC</Text>
<Animated.View style={[styles.spinRing, { transform: [{ rotate }] }]}>
<Text style={{ fontSize: 36, color: COLORS.orange }}>✦</Text>
</Animated.View>
</View>
);

const Speaking = () => (
<View style={styles.screen}>
<Text style={styles.mutedLabel}>TOPIC</Text>
<Text style={styles.speakingTopic}>{topic}</Text>

{!!micError && <Text style={styles.errorText}>{micError}</Text>}

<View style={{ flex: 1 }} />
<View style={styles.timerWrap}><Text style={styles.timerText}>{formatTime(timeLeft)}</Text></View>

{running && (
<View style={styles.liveTranscriptBox}>
<Text style={styles.liveTranscriptLabel}>RECORDING</Text>
<Text style={styles.liveTranscriptText}>We're recording — tap "Finish early" (or wait for the timer) and we'll transcribe your answer in a few seconds.</Text>
</View>
)}

{!!transcribeError && <Text style={[styles.errorText, { marginTop: 12 }]}>{transcribeError}</Text>}

<View style={{ flex: 1 }} />
{!running ? (
<TouchableOpacity style={styles.primaryButton} activeOpacity={0.8} onPress={startRecording}>
<Text style={styles.primaryButtonText}>Start yapping</Text>
</TouchableOpacity>
) : (
<TouchableOpacity style={styles.secondaryButton} activeOpacity={0.8} onPress={stopRecording}>
<Text style={styles.secondaryButtonText}>Finish early</Text>
</TouchableOpacity>
)}
</View>
);

const Transcribing = () => (
<View style={[styles.screen, { justifyContent: 'center', alignItems: 'center' }]}>
<Text style={styles.mutedLabel}>ONE SEC</Text>
<Text style={[styles.speakingTopic, { textAlign: 'center', marginTop: 8 }]}>Transcribing your answer…</Text>
</View>
);

const Review = () => (
<ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 24 }}>
<TouchableOpacity onPress={editFromReview} style={{ alignSelf: 'flex-end', marginBottom: 4 }}>
<Text style={{ color: COLORS.muted, fontSize: 12, textDecorationLine: 'underline' }}>Edit transcript</Text>
</TouchableOpacity>
<Text style={styles.mutedLabel}>SUMMARY</Text>
<Text style={styles.summaryText}>{review ? review.summary : 'No data yet.'}</Text>

{review && review.naturalVersion ? (
<View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: COLORS.orangeLight }]}>
<Text style={[styles.cardLabel, { color: COLORS.orangeLight }]}>NATURAL VERSION</Text>
<Text style={styles.cardBody}>{review.naturalVersion}</Text>
{aiLoading ? <Text style={[styles.smallMuted, { marginTop: 8 }]}>Getting a smarter rewrite...</Text> : null}
</View>
) : null}

{!!aiError ? (
<View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: '#E24B4A' }]}>
<Text style={[styles.cardLabel, { color: COLORS.red }]}>DEBUG: AI CALL FAILED</Text>
<Text style={styles.cardBody}>{aiError}</Text>
</View>
) : null}

{!!analysisError ? (
<View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: '#E24B4A' }]}>
<Text style={[styles.cardLabel, { color: COLORS.red }]}>DEBUG: ANALYSIS CALL FAILED</Text>
<Text style={styles.cardBody}>{analysisError}</Text>
</View>
) : null}

{analysisLoading ? <Text style={[styles.smallMuted, { marginTop: 4, marginBottom: 4 }]}>Refining your feedback with AI...</Text> : null}

{review && review.coaching ? (
<View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: COLORS.orangeLight }]}>
<Text style={[styles.cardLabel, { color: COLORS.orangeLight }]}>KEEP DEVELOPING THIS IDEA</Text>
<Text style={styles.smallMuted}>What's missing</Text>
<Text style={styles.cardBody}>{review.coaching.whatsMissing}</Text>
<Text style={[styles.smallMuted, { marginTop: 8 }]}>How to expand it</Text>
<Text style={styles.cardBody}>{review.coaching.howToExpand}</Text>
<Text style={[styles.smallMuted, { marginTop: 8 }]}>Example answer</Text>
<Text style={styles.cardBody}>{review.coaching.exampleAnswer}</Text>
<Text style={[styles.smallMuted, { marginTop: 8 }]}>Reusable pattern</Text>
<Text style={styles.cardBody}>{review.coaching.reusablePattern}</Text>
</View>
) : null}

{review && review.whatIMeant ? (
<View style={styles.card}>
<Text style={styles.cardLabel}>WHAT I THINK YOU MEANT</Text>
<Text style={styles.cardBody}>{review.whatIMeant}</Text>
</View>
) : null}

{review && review.yourStructure && review.yourStructure.length > 0 ? (
<View style={styles.card}>
<Text style={styles.cardLabel}>YOUR STRUCTURE</Text>
{review.yourStructure.map((part, idx) => (
<View key={idx} style={{ marginBottom: idx < review.yourStructure.length - 1 ? 10 : 0 }}>
<Text style={{ color: COLORS.orangeLight, fontSize: 11, fontWeight: '600', marginBottom: 3 }}>{part.label.toUpperCase()}</Text>
<Text style={styles.cardBody}>{part.text}</Text>
</View>
))}
<Text style={[styles.cardLabel, { marginTop: 14 }]}>IDEAL STRUCTURE</Text>
{(review.idealStructure || IDEAL_STRUCTURE).map((line, idx) => (
<Text key={idx} style={[styles.smallMuted, { marginBottom: 4 }]}>{(idx + 1) + '. ' + line}</Text>
))}
</View>
) : null}

{review && review.strongestLine ? (
<View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: COLORS.green }]}>
<Text style={[styles.cardLabel, { color: COLORS.green }]}>STRONGEST LINE</Text>
<Text style={styles.cardBody}>"{review.strongestLine}"</Text>
</View>
) : null}

{review && review.tightenList && review.tightenList.length > 0 ? review.tightenList.map((t, idx) => (
<View key={idx} style={[styles.card, { borderLeftWidth: 3, borderLeftColor: '#E24B4A' }]}>
<Text style={[styles.cardLabel, { color: COLORS.red }]}>TIGHTEN THIS</Text>
<Text style={styles.smallMuted}>You said</Text>
<Text style={styles.cardBody}>"{t.original}"</Text>
{t.noChangeNeeded ? (
<Text style={[styles.smallMuted, { marginTop: 8 }]}>This sentence is already natural. No change needed.</Text>
) : (
<>
<Text style={[styles.smallMuted, { marginTop: 8 }]}>Corrected</Text>
<Text style={styles.cardBody}>"{t.corrected}"</Text>
<Text style={[styles.smallMuted, { marginTop: 8 }]}>More fluent</Text>
<Text style={styles.cardBody}>"{t.moreFluent}"</Text>
</>
)}
</View>
)) : null}

{review && review.grammarFeedback && review.grammarFeedback.length > 0 ? (
<View style={styles.card}>
<Text style={styles.cardLabel}>GRAMMAR FEEDBACK</Text>
{review.grammarFeedback.map((g, idx) => (
<View key={idx} style={{ marginBottom: idx < review.grammarFeedback.length - 1 ? 12 : 0 }}>
<Text style={styles.cardBody}>"{g.mistake}"</Text>
<Text style={{ color: COLORS.orangeLight, fontSize: 11, fontWeight: '600', marginTop: 4 }}>{g.pattern}</Text>
<Text style={[styles.smallMuted, { marginTop: 2 }]}>{g.explanation}</Text>
</View>
))}
</View>
) : null}

{review && review.powerWords.length > 0 ? (
<View style={styles.card}>
<Text style={styles.cardLabel}>POWER WORDS</Text>
<View style={styles.pillRow}>
{review.powerWords.map((w) => <Text key={w} style={styles.powerPill}>{w}</Text>)}
</View>
</View>
) : null}

{review && review.weakWords.length > 0 ? (
<View style={styles.card}>
<Text style={styles.cardLabel}>WEAK WORDS</Text>
<View style={styles.pillRow}>
{review.weakWords.map((w) => <Text key={w} style={styles.weakPill}>{w}</Text>)}
</View>
</View>
) : null}

<View style={styles.card}>
<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
<Text style={styles.cardLabel}>PACE</Text>
<Text style={{ color: COLORS.orangeLight, fontWeight: '600' }}>{review ? review.wpm : 0} WPM</Text>
</View>
<Text style={[styles.smallMuted, { marginTop: 10 }]}>{review ? review.paceLabel : ''}</Text>
</View>

{review && (
<View style={styles.metricGrid}>
{[['Clarity', review.clarity], ['Confidence', review.confidence], ['Grammar', review.grammar], ['Pace', review.wpm]].map(([label, val]) => (
<View key={label} style={styles.metricCard}>
<Text style={styles.metricLabel}>{label}</Text>
<Text style={styles.metricValue}>{val}</Text>
</View>
))}
</View>
)}

<TouchableOpacity style={styles.primaryButton} activeOpacity={0.8} onPress={() => setScreen('home')}>
<Text style={styles.primaryButtonText}>Done</Text>
</TouchableOpacity>
</ScrollView>
);


const Stats = () => {
const m = weeklyStats ? weeklyStats.metrics : null;
const fmt = (v) => (v == null ? '—' : v);
const fmtPct = (p) => (p == null ? '' : (p >= 0 ? '↑ ' : '↓ ') + Math.abs(p) + '%');
return (
<View style={styles.screen}>
<Text style={styles.homeTitle}>This week</Text>
<ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
{weeklyStats && weeklyStats.thisWeekCount === 0 ? (
<View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: COLORS.orangeLight }]}>
<Text style={styles.cardBody}>No sessions logged yet this week. Complete today's lesson to start building your trend.</Text>
</View>
) : (
<View style={styles.metricGrid}>
{[
['Clarity', m ? fmt(m.clarity.value) : '—', m ? fmtPct(m.clarity.pct) : ''],
['Confidence', m ? fmt(m.confidence.value) : '—', m ? fmtPct(m.confidence.pct) : ''],
['Grammar', m ? fmt(m.grammar.value) : '—', m ? fmtPct(m.grammar.pct) : ''],
['Pace', m ? (m.wpm != null ? m.wpm + ' WPM' : '—') : '—', ''],
].map(([label, val, delta]) => (
<View key={label} style={styles.metricCard}>
<Text style={styles.metricLabel}>{label}</Text>
<View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
<Text style={styles.metricValue}>{val}</Text>
{!!delta && <Text style={{ color: COLORS.greenText, fontSize: 12, marginLeft: 6 }}>{delta}</Text>}
</View>
</View>
))}
</View>
)}

{weeklyStats && weeklyStats.dailyTrend ? (
<View style={styles.card}>
<Text style={styles.cardLabel}>7-DAY TREND</Text>
<View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 70, marginTop: 8 }}>
{weeklyStats.dailyTrend.map((d, idx) => (
<View key={idx} style={{ alignItems: 'center', flex: 1 }}>
<View style={{
width: 14,
height: d.score != null ? Math.max(6, (d.score / 100) * 56) : 4,
backgroundColor: d.score != null ? COLORS.orange : COLORS.border,
borderRadius: 4,
}} />
<Text style={{ color: COLORS.muted, fontSize: 10, marginTop: 6 }}>{d.label}</Text>
</View>
))}
</View>
</View>
) : null}
<View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: COLORS.green }]}>
<Text style={[styles.cardLabel, { color: COLORS.green }]}>WHAT IMPROVED</Text>
<Text style={styles.cardBody}>{weeklyStats ? weeklyStats.whatImproved : 'Loading...'}</Text>
</View>
<View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: COLORS.orangeLight }]}>
<Text style={[styles.cardLabel, { color: COLORS.orangeLight }]}>FOCUS NEXT</Text>
<Text style={styles.cardBody}>{weeklyStats ? weeklyStats.focusNext : ''}</Text>
</View>
<TouchableOpacity
style={{ paddingVertical: 12, alignItems: 'center' }}
onPress={() => {
clearSessions();
setWeeklyStats(computeWeeklyStats([]));
}}
>
<Text style={{ color: COLORS.muted, fontSize: 12, textDecorationLine: 'underline' }}>Reset my data</Text>
</TouchableOpacity>
</ScrollView>
<TabBar active="stats" onStats={() => setScreen('stats')} onLesson={() => setScreen('home')} />
</View>
);
};

const TabBar = ({ active, onStats, onLesson }) => (
<View style={styles.tabBar}>
<TouchableOpacity style={styles.tabItem} onPress={onLesson}>
<Text style={{ color: active === 'lesson' ? COLORS.orangeLight : COLORS.muted, fontSize: 12, fontWeight: '500' }}>Today's lesson</Text>
</TouchableOpacity>
<TouchableOpacity style={styles.tabItem} onPress={onStats}>
<Text style={{ color: active === 'stats' ? COLORS.orangeLight : COLORS.muted, fontSize: 12, fontWeight: '500' }}>Weekly stats</Text>
</TouchableOpacity>
</View>
);

if (needKey) {
return (
<View style={[styles.screen, { justifyContent: 'center' }]}>
<StatusBar barStyle="light-content" />
<Text style={styles.homeTitle}>Connect Groq</Text>
<Text style={[styles.summaryText, { color: COLORS.muted }]}>Paste your Groq API key once. It is saved only on this phone and is only sent to Groq.</Text>
<TextInput
style={{ backgroundColor: COLORS.card, borderRadius: 14, padding: 16, color: COLORS.text, fontSize: 15, marginBottom: 16 }}
value={keyDraft}
onChangeText={setKeyDraft}
placeholder="gsk_..."
placeholderTextColor={COLORS.muted}
autoCapitalize="none"
autoCorrect={false}
/>
<TouchableOpacity style={styles.primaryButton} onPress={() => { if (saveApiKey(keyDraft)) { setKeyDraft(''); setNeedKey(false); } }}>
<Text style={styles.primaryButtonText}>Save key</Text>
</TouchableOpacity>
{getApiKey() ? (
<TouchableOpacity style={styles.secondaryButton} onPress={() => setNeedKey(false)}>
<Text style={styles.secondaryButtonText}>Cancel</Text>
</TouchableOpacity>
) : null}
</View>
);
}

return (
<View style={{ flex: 1, backgroundColor: COLORS.bg }}>
<StatusBar barStyle="light-content" />
{screen === 'home' && <Home />}
{screen === 'home' && (
<TouchableOpacity style={{ position: 'absolute', top: 14, right: 16, padding: 8 }} onPress={() => { setKeyDraft(''); setNeedKey(true); }}>
<Text style={{ color: COLORS.muted, fontSize: 18 }}>🔑</Text>
</TouchableOpacity>
)}
{screen === 'spinning' && <Spinning />}
{screen === 'speaking' && <Speaking />}
{screen === 'transcribing' && <Transcribing />}
{screen === 'edit' && (
<EditTranscriptScreen
value={editedTranscript}
onChangeText={setEditedTranscript}
onConfirm={confirmTranscriptAndReview}
/>
)}
{screen === 'review' && <Review />}
{screen === 'stats' && <Stats />}
</View>
);
}

const styles = StyleSheet.create({
screen: { flex: 1, backgroundColor: COLORS.bg, paddingHorizontal: 20, paddingTop: 24 },
dateLabel: { color: COLORS.orangeLight, letterSpacing: 3, fontSize: 12, fontWeight: '600', marginBottom: 14 },
homeTitle: { color: COLORS.text, fontSize: 26, fontWeight: '600', marginBottom: 10 },
mutedLabel: { color: COLORS.orangeLight, letterSpacing: 2, fontSize: 11, fontWeight: '600', marginBottom: 10 },
circleWrap: { alignItems: 'center', marginBottom: 30 },
circleOutline: { width: 110, height: 110, borderRadius: 55, borderWidth: 2, borderColor: COLORS.orange, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
circleCaption: { color: COLORS.muted, fontSize: 13 },
primaryButton: { backgroundColor: COLORS.orange, paddingVertical: 18, borderRadius: 16, alignItems: 'center', marginBottom: 6 },
primaryButtonText: { color: COLORS.bg, fontSize: 16, fontWeight: '700' },
secondaryButton: { borderWidth: 1, borderColor: COLORS.border, paddingVertical: 16, borderRadius: 14, alignItems: 'center', marginBottom: 20 },
secondaryButtonText: { color: '#B8A99C', fontSize: 14, fontWeight: '500' },
spinRing: { width: 180, height: 180, borderRadius: 90, borderWidth: 3, borderColor: COLORS.orange, alignItems: 'center', justifyContent: 'center', marginTop: 30 },
speakingTopic: { color: COLORS.text, fontSize: 22, fontWeight: '500', lineHeight: 30 },
errorText: { color: COLORS.red, fontSize: 13, marginTop: 12 },
timerWrap: { alignSelf: 'center', width: 180, height: 180, borderRadius: 90, borderWidth: 6, borderColor: COLORS.orange, alignItems: 'center', justifyContent: 'center' },
timerText: { color: COLORS.orangeLight, fontSize: 38, fontWeight: '600' },
liveTranscriptBox: { backgroundColor: COLORS.card, borderRadius: 14, padding: 14, marginTop: 20 },
liveTranscriptLabel: { color: COLORS.muted, fontSize: 10, letterSpacing: 1, marginBottom: 6 },
liveTranscriptText: { color: COLORS.text, fontSize: 13, lineHeight: 20 },
transcriptInput: { flex: 1, backgroundColor: COLORS.card, borderRadius: 14, padding: 16, color: COLORS.text, fontSize: 15, lineHeight: 22, marginBottom: 16 },
summaryText: { color: COLORS.text, fontSize: 15, lineHeight: 24, marginBottom: 16 },
card: { backgroundColor: COLORS.card, borderRadius: 14, padding: 16, marginBottom: 12 },
cardLabel: { color: COLORS.muted, fontSize: 11, fontWeight: '600', letterSpacing: 1, marginBottom: 8 },
cardBody: { color: COLORS.text, fontSize: 14, lineHeight: 22 },
smallMuted: { color: COLORS.muted, fontSize: 11 },
pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
powerPill: { backgroundColor: COLORS.powerBg, color: COLORS.greenText, fontSize: 12, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 20, overflow: 'hidden' },
weakPill: { backgroundColor: COLORS.weakBg, color: COLORS.weakText, fontSize: 12, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 20, overflow: 'hidden' },
metricGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 8 },
metricCard: { backgroundColor: COLORS.card, borderRadius: 12, padding: 14, width: '48%', marginBottom: 12 },
metricLabel: { color: COLORS.muted, fontSize: 11, marginBottom: 6 },
metricValue: { color: COLORS.text, fontSize: 20, fontWeight: '600' },
tabBar: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 16, marginTop: 10, borderTopWidth: 1, borderTopColor: COLORS.border },
tabItem: { alignItems: 'center', paddingVertical: 6 },
});