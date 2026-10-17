const KEY = 'daylight.voiceBriefing.v1';

export const DEFAULT_VOICE_BRIEFING = { enabled: false, time: '08:00', day: 'today', voiceURI: '' };

export function readVoiceBriefingPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '');
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed?.time) ? parsed.time : DEFAULT_VOICE_BRIEFING.time;
    return {
      enabled: parsed?.enabled === true,
      time,
      day: parsed?.day === 'tomorrow' ? 'tomorrow' : 'today',
      voiceURI: String(parsed?.voiceURI || ''),
      lastKey: String(parsed?.lastKey || ''),
    };
  } catch {
    return { ...DEFAULT_VOICE_BRIEFING, lastKey: '' };
  }
}

export function writeVoiceBriefingPrefs(prefs) {
  const next = { ...readVoiceBriefingPrefs(), ...prefs };
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event('daylight-voice-briefing'));
  return next;
}

export function beijingNowKey(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 3_600_000);
  const day = shifted.toISOString().slice(0, 10);
  const time = shifted.toISOString().slice(11, 16);
  return { day, time };
}

export function listChineseVoices() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const chinese = voices.filter((voice) => /zh|Chinese/i.test(`${voice.lang} ${voice.name}`));
  return chinese.length ? chinese : voices;
}

export function speakBriefing(text, voiceURI) {
  if (!window.speechSynthesis) return Promise.reject(new Error('这台浏览器不能播报语音。'));
  window.speechSynthesis.cancel();
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    const voices = listChineseVoices();
    utterance.voice = voices.find((voice) => voice.voiceURI === voiceURI)
      || voices.find((voice) => /zh-CN|Ting|Xiaoxiao|Yunxi|豆包/i.test(`${voice.lang} ${voice.name}`))
      || voices[0]
      || null;
    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error('语音播报被打断。'));
    window.speechSynthesis.speak(utterance);
  });
}
