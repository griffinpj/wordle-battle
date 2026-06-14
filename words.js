// Word list + validation + scoring.
//
// Sources:
//  - Curated common ANSWERS list (good targets — recognizable, fair to guess).
//  - `an-array-of-english-words` (~275k entries) filtered to 5-letter, lowercase a-z.
//  - Runtime fallback to dictionaryapi.dev for words outside the local list,
//    so obscure-but-real words still get accepted (cached).
//
// All three layers cooperate: target words are only ever drawn from the curated
// ANSWERS list (no obscure surprises), but guesses are validated against the
// broader corpus and the dictionary API.

const englishWords = require("an-array-of-english-words");

const ANSWERS = [
  "about","above","abuse","actor","acute","admit","adopt","adult","after","again",
  "agent","agree","ahead","alarm","album","alert","alike","alive","allow","alone",
  "along","alter","among","anger","angle","angry","apart","apple","apply","arena",
  "argue","arise","array","aside","asset","audio","audit","avoid","award","aware",
  "badly","baker","bases","basic","beach","began","begin","begun","being","below",
  "bench","billy","birth","black","blame","blind","block","blood","board","boost",
  "booth","bound","brain","brand","bread","break","breed","brief","bring","broad",
  "broke","brown","build","built","buyer","cable","carry","catch","cause",
  "chain","chair","chart","chase","cheap","check","chest","chief","child","china",
  "chose","civil","claim","class","clean","clear","click","clock","close","coach",
  "coast","could","count","court","cover","craft","crash","cream","crime","cross",
  "crowd","crown","curve","cycle","daily","dance","dated","dealt","death","debut",
  "delay","depth","doing","doubt","dozen","draft","drama","drawn","dream","dress",
  "drill","drink","drive","drove","dying","eager","early","earth","eight","elite",
  "empty","enemy","enjoy","enter","entry","equal","error","event","every","exact",
  "exist","extra","faith","false","fault","fiber","field","fifth","fifty","fight",
  "final","first","fixed","flash","fleet","floor","fluid","focus","force","forth",
  "forty","forum","found","frame","frank","fraud","fresh","front","fruit","fully",
  "funny","giant","given","glass","globe","going","grace","grade","grand","grant",
  "grass","great","green","gross","group","grown","guard","guess","guest","guide",
  "happy","heart","heavy","hence","horse","hotel","house","human","ideal",
  "image","index","inner","input","issue","joint","judge",
  "known","label","large","laser","later","laugh","layer","learn","lease","least",
  "leave","legal","level","light","limit","links","lives","local","logic",
  "loose","lower","lucky","lunch","lying","magic","major","maker","march",
  "match","maybe","mayor","meant","media","metal","might","minor","minus","mixed",
  "model","money","month","moral","motor","mount","mouse","mouth","movie","music",
  "needs","never","newly","night","noise","north","noted","novel","nurse","occur",
  "ocean","offer","often","order","other","ought","paint","panel","paper","party",
  "peace","phase","phone","photo","piece","pilot","pitch","place","plain",
  "plane","plant","plate","point","pound","power","press","price","pride","prime",
  "print","prior","prize","proof","proud","prove","queen","quick","quiet","quite",
  "radio","raise","range","rapid","ratio","reach","ready","refer","right","rival",
  "river","rough","round","route","royal","rural","scale",
  "scene","scope","score","sense","serve","seven","shall","shape","share","sharp",
  "sheet","shelf","shell","shift","shirt","shock","shoot","short","shown","sight",
  "since","sixth","sixty","sized","skill","sleep","slide","small","smart","smile",
  "smoke","solid","solve","sorry","sound","south","space","spare","speak",
  "speed","spend","spent","split","spoke","sport","staff","stage","stake","stand",
  "start","state","steam","steel","stick","still","stock","stone","stood","store",
  "storm","story","strip","stuck","study","stuff","style","sugar","suite","super",
  "sweet","table","taken","taste","taxes","teach","teeth","thank","theft",
  "their","theme","there","these","thick","thing","think","third","those","three",
  "threw","throw","tight","times","tired","title","today","topic","total","touch",
  "tough","tower","track","trade","train","treat","trend","trial","tried","tries",
  "truck","truly","trust","truth","twice","under","undue","union","unity","until",
  "upper","upset","urban","usage","usual","valid","value","video","virus","visit",
  "vital","voice","waste","watch","water","wheel","where","which","while","white",
  "whole","whose","woman","women","world","worry","worse","worst","worth","would",
  "wound","write","wrong","wrote","yield","young","youth","brisk","crane","cleat",
  "drift","flame","glint","heron","ivory","jolly","kneel","mango","onset",
  "ravel","spire","trout","ultra","vivid","waltz","xenon","yacht","zebra",
  "amber","baron","candy","clamp","crisp","daisy","dwell","eagle","elbow","ember",
  "fancy","feast","flock","forge","gloom","grape","haste","hover","jelly","knack",
  "lemon","lodge","mirth","nudge","ozone","peach","quill","raven","ridge","scout",
  "sieve","tango","tonic","torch","ultra","verge","wager","whirl","yodel","zonal",
];

// Build big valid-guess set: curated + 5-letter english words.
const VALID_SET = new Set(ANSWERS);
for (const w of englishWords) {
  if (typeof w !== "string") continue;
  if (w.length !== 5) continue;
  if (!/^[a-z]+$/.test(w)) continue;
  VALID_SET.add(w);
}

function randomAnswer() {
  return ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
}

function isFormatOk(w) {
  return typeof w === "string" && w.length === 5 && /^[a-z]+$/.test(w);
}

function isInLocalList(w) {
  return VALID_SET.has(w);
}

// Dictionary API fallback (cached). Free, no key, sometimes flaky — used
// only when a guess isn't in our local list.
const dictCache = new Map(); // word -> boolean
const NEGATIVE_TTL = 5 * 60 * 1000;
const dictNegativeAt = new Map(); // word -> ts of last negative

async function lookupDictionary(w) {
  if (dictCache.has(w)) {
    if (dictCache.get(w) === false) {
      const at = dictNegativeAt.get(w) || 0;
      if (Date.now() - at < NEGATIVE_TTL) return false;
    } else {
      return true;
    }
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(t);
    const ok = r.ok;
    dictCache.set(w, ok);
    if (!ok) dictNegativeAt.set(w, Date.now());
    return ok;
  } catch {
    dictCache.set(w, false);
    dictNegativeAt.set(w, Date.now());
    return false;
  }
}

async function validateGuess(w) {
  if (!isFormatOk(w)) return false;
  if (isInLocalList(w)) return true;
  return await lookupDictionary(w);
}

function score(guess, target) {
  const g = guess.split("");
  const t = target.split("");
  const result = ["absent","absent","absent","absent","absent"];
  const tCounts = {};
  for (let i = 0; i < 5; i++) {
    if (g[i] === t[i]) {
      result[i] = "correct";
    } else {
      tCounts[t[i]] = (tCounts[t[i]] || 0) + 1;
    }
  }
  for (let i = 0; i < 5; i++) {
    if (result[i] === "correct") continue;
    if (tCounts[g[i]] > 0) {
      result[i] = "present";
      tCounts[g[i]]--;
    }
  }
  return result;
}

module.exports = {
  ANSWERS,
  randomAnswer,
  isFormatOk,
  isInLocalList,
  validateGuess,
  score,
  validSetSize: VALID_SET.size,
};
