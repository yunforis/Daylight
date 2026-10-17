import { useEffect, useState } from 'react';
import { LoaderCircle, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { request } from '@/lib/api';
import { beijingNowKey, listChineseVoices, readVoiceBriefingPrefs, speakBriefing, writeVoiceBriefingPrefs } from '@/lib/voice-briefing';

async function playBriefing(prefs, { markPlayed = false } = {}) {
  const result = await request('/voice-briefing', 'POST', { day: prefs.day });
  await speakBriefing(result.text, prefs.voiceURI);
  if (markPlayed) {
    const clock = beijingNowKey();
    writeVoiceBriefingPrefs({ lastKey: `${clock.day}:${prefs.time}` });
  }
  return result;
}

export function VoiceBriefingCard() {
  const [prefs, setPrefs] = useState(() => readVoiceBriefingPrefs());
  const [voices, setVoices] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const refresh = () => setVoices(listChineseVoices());
    refresh();
    window.speechSynthesis?.addEventListener?.('voiceschanged', refresh);
    return () => window.speechSynthesis?.removeEventListener?.('voiceschanged', refresh);
  }, []);

  const save = (patch) => setPrefs(writeVoiceBriefingPrefs(patch));

  const preview = async () => {
    setBusy(true);
    try {
      const result = await playBriefing(prefs);
      toast.success(result.source === 'model' ? '已用模型生成并播报' : '已按日程原文播报');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Volume2 className="size-4" />日程语音播报</CardTitle>
        <CardDescription>打开 Daylight 后，每天到设定的北京时间，用中文语音播报今天或明天的日程。模型会把日程写成口播稿；没有配置模型时，直接按时间和标题朗读。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
          每天播报
          <Switch checked={prefs.enabled} onCheckedChange={(enabled) => save({ enabled })} />
        </label>
        <label className="grid gap-1 text-sm">
          播报时间
          <input className="h-9 rounded-md border bg-background px-3" type="time" value={prefs.time} onChange={(event) => save({ time: event.target.value })} />
        </label>
        <label className="grid gap-1 text-sm">
          播报哪一天
          <select className="h-9 rounded-md border bg-background px-3" value={prefs.day} onChange={(event) => save({ day: event.target.value })}>
            <option value="today">今天的日程</option>
            <option value="tomorrow">明天的日程</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          声音
          <select className="h-9 rounded-md border bg-background px-3" value={prefs.voiceURI} onChange={(event) => save({ voiceURI: event.target.value })}>
            <option value="">自动选择中文语音</option>
            {voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}
          </select>
        </label>
        <div className="md:col-span-2 flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={busy} onClick={preview}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Volume2 className="size-4" />}
            立即试听
          </Button>
          <p className="text-xs text-muted-foreground">页面需要保持打开。Mac 可在系统设置里安装「婷婷」等中文语音；如果系统里有豆包或其他中文语音，也会出现在上面的列表中。</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function VoiceBriefingHost() {
  useEffect(() => {
    let stopped = false;
    let running = false;
    const tick = async () => {
      const prefs = readVoiceBriefingPrefs();
      if (!prefs.enabled || stopped || running) return;
      const clock = beijingNowKey();
      const slot = `${clock.day}:${prefs.time}`;
      if (clock.time !== prefs.time || prefs.lastKey === slot) return;
      running = true;
      try {
        await playBriefing(prefs, { markPlayed: true });
        toast.message(prefs.day === 'tomorrow' ? '已播报明天的日程' : '已播报今天的日程');
      } catch (error) {
        writeVoiceBriefingPrefs({ lastKey: slot });
        toast.error(error.message || '日程播报失败');
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(tick, 20000);
    const onChange = () => {};
    window.addEventListener('daylight-voice-briefing', onChange);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('daylight-voice-briefing', onChange);
    };
  }, []);
  return null;
}
