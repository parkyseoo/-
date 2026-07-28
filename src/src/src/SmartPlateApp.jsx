import React, { useState, useMemo, useCallback } from "react";
import {
  Bluetooth,
  BluetoothConnected,
  Home,
  History,
  FileDown,
  Settings2,
  ChevronLeft,
  AlertTriangle,
  CheckCircle2,
  Gauge as GaugeIcon,
  Plus,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";

/* ---------------------------------------------------------------
   스마트 플레이트 연동 다이어트 앱 — 프로토타입 구현
   실제 하드웨어(아두이노 + 로드셀) 없이도 UX/데이터 흐름을 검증할 수 있도록
   "블루투스 수신"을 시뮬레이션 버튼으로 재현했습니다.
   실기기 연동 시에는 Web Bluetooth / Android BLE로 아래 receiveSession()에
   전달되는 패킷 파싱 로직만 실제 GATT 콜백으로 교체하면 됩니다.
----------------------------------------------------------------- */

const CATEGORIES = ["탄수화물 위주", "단백질 위주", "지방/혼합", "없음"];
const CYCLE_KCAL = 7700; // 체지방 1kg

const LEFTOVER_LABEL = {
  "탄수화물 위주": "탄수화물",
  "단백질 위주": "단백질",
  "지방/혼합": "지방/혼합",
  없음: "없음",
};

function calcBMR({ gender, height, age, weight }) {
  // Mifflin-St Jeor
  const base = 10 * weight + 6.25 * height - 5 * age;
  return gender === "male" ? base + 5 : base - 161;
}

function calcTargetKcal(profile, mode) {
  const bmr = calcBMR(profile);
  const tdee = bmr * 1.4; // 활동계수 가정
  const perMeal = mode === "fast" ? (tdee - 500) / 3 : (tdee - 300) / 3;
  return Math.max(300, Math.round(perMeal));
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(
    2,
    "0"
  )}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/* 아두이노가 보냈을 법한 원시 시리얼 문자열을 만든 뒤, 실제 파서를 태워서 세션을 만든다.
   즉 "시뮬레이션"이라도 receiveSession → parseSerialPacket 경로를 그대로 통과한다. */
function simulateIncomingPacket(profile, mode) {
  const target = calcTargetKcal(profile, mode);
  const noise = 0.75 + Math.random() * 0.6; // 실제 섭취량 변동
  const actual = Math.round(target * noise);
  const deficit = target - actual;
  const paceViolations = Math.random() < 0.35 ? Math.ceil(Math.random() * 3) : 0;
  const leftover = deficit < -150 ? CATEGORIES[Math.floor(Math.random() * 3)] : "없음";
  const timestamp = Date.now() - Math.floor(Math.random() * 1000 * 60 * 5);

  const raw = [
    new Date(timestamp).toISOString().slice(0, 19),
    mode,
    target,
    actual,
    paceViolations,
    deficit,
    leftover,
  ].join(",");

  return raw;
}

/* 아두이노 → 앱 블루투스 시리얼 패킷 규격
   [DATE, MODE, E_TARGET, E_ACTUAL, SPEED_VIOLATION, E_DEFICIT, LEFTOVER_CAT]
   예) 2026-07-23T18:30:00,healthy,650,610,0,40,없음
   중간에 값이 깨져 들어와도 앱이 죽지 않도록 필드별로 검증 후 실패 사유를 반환한다. */
function parseSerialPacket(raw) {
  try {
    const fields = raw.split(",").map((f) => f.trim());
    if (fields.length !== 7) {
      throw new Error(`필드 개수가 7개가 아니에요 (수신: ${fields.length}개)`);
    }
    const [dateStr, modeRaw, targetRaw, actualRaw, violRaw, deficitRaw, leftoverRaw] = fields;

    const timestamp = Date.parse(dateStr);
    if (Number.isNaN(timestamp)) {
      throw new Error(`DATE 필드를 해석할 수 없어요: "${dateStr}"`);
    }

    const mode = modeRaw.toLowerCase();
    if (!["healthy", "fast"].includes(mode)) {
      throw new Error(`MODE 값이 올바르지 않아요: "${modeRaw}" (healthy|fast만 허용)`);
    }

    const targetKcal = Number(targetRaw);
    const actualKcal = Number(actualRaw);
    const paceViolations = Number(violRaw);
    const deficit = Number(deficitRaw);
    if ([targetKcal, actualKcal, paceViolations, deficit].some((n) => Number.isNaN(n))) {
      throw new Error("칼로리/위반 횟수 필드에 숫자가 아닌 값이 섞여 있어요.");
    }

    const leftoverCategory = CATEGORIES.includes(leftoverRaw) ? leftoverRaw : "없음";

    return {
      ok: true,
      session: {
        id: uid(),
        timestamp,
        mode,
        targetKcal,
        actualKcal,
        paceViolations,
        deficit,
        leftoverCategory,
        status: "ok",
      },
    };
  } catch (err) {
    return { ok: false, error: err.message, raw };
  }
}

function buildSerialPacket(session) {
  return [
    new Date(session.timestamp).toISOString().slice(0, 19),
    session.mode,
    session.targetKcal,
    session.actualKcal,
    session.paceViolations,
    session.deficit,
    session.leftoverCategory,
  ].join(",");
}

/* ---------------------------- 게이지 ---------------------------- */
function DeficitGauge({ sessions, alert }) {
  const { cumulative, cyclesDone } = useMemo(() => {
    let cum = 0;
    let cycles = 0;
    const sorted = [...sessions].sort((a, b) => a.timestamp - b.timestamp);
    for (const s of sorted) {
      cum += s.deficit;
      if (cum < 0) cum = 0; // 하한 처리
      while (cum >= CYCLE_KCAL) {
        cum -= CYCLE_KCAL;
        cycles += 1;
      }
    }
    return { cumulative: cum, cyclesDone: cycles };
  }, [sessions]);

  const pct = Math.min(1, cumulative / CYCLE_KCAL);
  const r = 54;
  const c = 2 * Math.PI * r;
  const lastSession = sessions[sessions.length - 1];

  return (
    <div className="rounded-2xl bg-[#16211C] p-5 text-[#EFF7F0] flex items-center gap-5">
      <svg width="128" height="128" viewBox="0 0 128 128" className="shrink-0">
        <circle cx="64" cy="64" r={r} fill="none" stroke="#233A2E" strokeWidth="12" />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke={alert ? "#F0968A" : "#8CF07A"}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform="rotate(-90 64 64)"
          style={{
            transition: "stroke-dashoffset 600ms ease, stroke 200ms ease",
            animation: alert ? "gaugeFlash 500ms ease-in-out 3" : "none",
          }}
        />
        <text x="64" y="58" textAnchor="middle" fontSize="20" fontFamily="'IBM Plex Mono', monospace" fill="#EFF7F0" fontWeight="600">
          {Math.round(pct * 100)}%
        </text>
        <text x="64" y="76" textAnchor="middle" fontSize="9" fontFamily="'IBM Plex Mono', monospace" fill="#8FAF9B">
          {cyclesDone}kg 달성
        </text>
      </svg>
      <div className="flex-1 space-y-1.5">
        <div className="text-xs uppercase tracking-wider text-[#8FAF9B] font-mono">
          체지방 1kg 게이지 (7,700kcal)
        </div>
        <div className="font-mono text-2xl font-semibold">
          {cumulative.toLocaleString()} <span className="text-sm text-[#8FAF9B]">/ {CYCLE_KCAL.toLocaleString()} kcal</span>
        </div>
        {lastSession && (
          <div className={`inline-flex items-center gap-1.5 text-xs mt-1 rounded-full px-2.5 py-1 ${lastSession.deficit >= 0 ? "bg-[#233A2E] text-[#8CF07A]" : "bg-[#3A2323] text-[#F0968A]"}`}>
            {lastSession.deficit >= 0 ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            최근 세션 {lastSession.deficit >= 0 ? "+" : ""}
            {lastSession.deficit} kcal
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- 오늘 요약 카드 ---------------------------- */
function TodaySummary({ sessions }) {
  const today = dayKey(Date.now());
  const todaySessions = sessions.filter((s) => dayKey(s.timestamp) === today);
  const totals = todaySessions.reduce(
    (acc, s) => {
      acc.actual += s.actualKcal;
      acc.deficit += s.deficit;
      acc.violations += s.paceViolations;
      return acc;
    },
    { actual: 0, deficit: 0, violations: 0 }
  );

  const cards = [
    { label: "오늘 총 섭취", value: `${totals.actual.toLocaleString()}`, unit: "kcal" },
    {
      label: "오늘 총 적자",
      value: `${totals.deficit >= 0 ? "+" : ""}${totals.deficit.toLocaleString()}`,
      unit: "kcal",
      warn: totals.deficit < 0,
    },
    { label: "오늘 속도 위반", value: `${totals.violations}`, unit: "회", warn: totals.violations > 0 },
  ];

  return (
    <div className="grid grid-cols-3 gap-2.5">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-[#E4DED2] bg-white p-3">
          <div className="text-[11px] text-[#8A8172] font-medium leading-tight mb-1.5">{c.label}</div>
          <div className={`font-mono text-lg font-semibold ${c.warn ? "text-[#C0503E]" : "text-[#22301F]"}`}>
            {c.value}
            <span className="text-[10px] text-[#8A8172] ml-0.5 font-sans">{c.unit}</span>
          </div>
        </div>
      ))}
      {todaySessions.length === 0 && (
        <div className="col-span-3 text-center text-xs text-[#A79F8E] py-2">
          오늘 기록된 식사가 아직 없어요.
        </div>
      )}
    </div>
  );
}

/* ---------------------------- 주간 추이 그래프 ---------------------------- */
function WeeklyChart({ sessions, onPickDay }) {
  const data = useMemo(() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = dayKey(d.getTime());
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      const dayTotal = sessions
        .filter((s) => dayKey(s.timestamp) === key)
        .reduce((sum, s) => sum + s.deficit, 0);
      days.push({ key, label, deficit: dayTotal });
    }
    return days;
  }, [sessions]);

  return (
    <div className="rounded-2xl border border-[#E4DED2] bg-white p-4">
      <div className="text-xs font-semibold text-[#5B5646] mb-3 font-mono uppercase tracking-wide">
        최근 7일 적자(±) 추이
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <BarChart data={data} onClick={(e) => e?.activeLabel && onPickDay(data.find((d) => d.label === e.activeLabel)?.key)}>
          <CartesianGrid strokeDasharray="3 3" stroke="#EEE8DB" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#8A8172" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: "#8A8172" }} axisLine={false} tickLine={false} width={36} />
          <ReferenceLine y={0} stroke="#C9C1AF" />
          <Tooltip
            cursor={{ fill: "#F4EFE3" }}
            formatter={(v) => [`${v} kcal`, "적자(±)"]}
            contentStyle={{ borderRadius: 10, border: "1px solid #E4DED2", fontSize: 12 }}
          />
          <Bar dataKey="deficit" radius={[4, 4, 4, 4]} cursor="pointer">
            {data.map((d, i) => (
              <rect key={i} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ---------------------------- 세션 목록 / 상세 ---------------------------- */
function SessionRow({ s, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between rounded-xl border border-[#E4DED2] bg-white px-3.5 py-3 text-left hover:border-[#8CB27A] transition-colors"
    >
      <div>
        <div className="text-sm font-medium text-[#22301F]">{fmtDate(s.timestamp)}</div>
        <div className="text-[11px] text-[#8A8172] mt-0.5">
          {s.mode === "fast" ? "빠른 감량" : "건강한 감량"} · 잔반 {LEFTOVER_LABEL[s.leftoverCategory]}
        </div>
      </div>
      <div className="text-right">
        <div className={`font-mono text-sm font-semibold ${s.deficit >= 0 ? "text-[#3E7A3A]" : "text-[#C0503E]"}`}>
          {s.deficit >= 0 ? "+" : ""}
          {s.deficit} kcal
        </div>
        {s.paceViolations > 0 && (
          <div className="text-[10px] text-[#C0503E]">속도 위반 {s.paceViolations}회</div>
        )}
      </div>
    </button>
  );
}

function SessionDetail({ s, onBack }) {
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-[#5B5646]">
        <ChevronLeft size={16} /> 목록으로
      </button>
      <div className="rounded-2xl border border-[#E4DED2] bg-white p-4 space-y-3">
        <div className="text-xs text-[#8A8172] font-mono">{fmtDate(s.timestamp)}</div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="목표 kcal" value={s.targetKcal} />
          <Stat label="실제 섭취 kcal" value={s.actualKcal} />
          <Stat label={s.deficit >= 0 ? "적자" : "초과"} value={`${s.deficit >= 0 ? "+" : ""}${s.deficit}`} warn={s.deficit < 0} />
          <Stat label="속도 위반" value={`${s.paceViolations}회`} warn={s.paceViolations > 0} />
        </div>
        <div className="flex items-center justify-between text-sm pt-2 border-t border-[#EEE8DB]">
          <span className="text-[#8A8172]">모드</span>
          <span className="font-medium">{s.mode === "fast" ? "빠른 감량" : "건강한 감량"}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-[#8A8172]">잔반 카테고리</span>
          <span className="font-medium">{LEFTOVER_LABEL[s.leftoverCategory]}</span>
        </div>
      </div>
      <details className="rounded-xl border border-dashed border-[#D8D0BE] p-3 text-[11px] font-mono text-[#8A8172]">
        <summary className="cursor-pointer text-[#5B5646]">원본 수신 로그 (디버그)</summary>
        <div className="mt-2 text-[#5B5646]">RAW PACKET</div>
        <pre className="whitespace-pre-wrap">{buildSerialPacket(s)}</pre>
        <div className="mt-2 text-[#5B5646]">PARSED</div>
        <pre className="whitespace-pre-wrap">{JSON.stringify(s, null, 2)}</pre>
      </details>
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div className="rounded-lg bg-[#FAF7EF] px-3 py-2">
      <div className="text-[10px] text-[#8A8172]">{label}</div>
      <div className={`font-mono text-base font-semibold ${warn ? "text-[#C0503E]" : "text-[#22301F]"}`}>{value}</div>
    </div>
  );
}

/* ---------------------------- CSV 내보내기 ---------------------------- */
function ReportScreen({ sessions }) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState("");

  const filtered = sessions.filter((s) => {
    const d = new Date(s.timestamp).toISOString().slice(0, 10);
    return d >= from && d <= to;
  });

  const buildCsv = useCallback(() => {
    const header = "timestamp,mode,target_kcal,actual_kcal,deficit_kcal,pace_violations,leftover_category";
    const rows = filtered.map((s) =>
      [
        new Date(s.timestamp).toISOString(),
        s.mode,
        s.targetKcal,
        s.actualKcal,
        s.deficit,
        s.paceViolations,
        s.leftoverCategory,
      ].join(",")
    );
    return [header, ...rows].join("\n");
  }, [filtered]);

  const handleExport = useCallback(() => {
    if (filtered.length === 0) {
      setMsg("선택한 기간에 데이터가 없어요.");
      return;
    }
    const csv = buildCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smartplate_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg(`${filtered.length}건의 세션을 다운로드했어요.`);
  }, [filtered, from, to, buildCsv]);

  const handleShare = useCallback(async () => {
    if (filtered.length === 0) {
      setMsg("선택한 기간에 데이터가 없어요.");
      return;
    }
    const csv = buildCsv();
    const file = new File([csv], `smartplate_${from}_${to}.csv`, { type: "text/csv" });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: "스마트 플레이트 식사 기록",
          text: `${from} ~ ${to} 식사 기록 (${filtered.length}건)`,
        });
        setMsg("공유 시트를 열었어요. 카카오톡/이메일 등에서 첨부해 전달하세요.");
        return;
      } catch (err) {
        // 사용자가 공유를 취소한 경우 등 — 조용히 다운로드로 대체
      }
    }
    // Web Share API 미지원 브라우저 대비 폴백
    handleExport();
    setMsg("이 브라우저는 공유 시트를 지원하지 않아 파일 다운로드로 대체했어요. 다운로드한 CSV를 카카오톡/이메일에 직접 첨부해주세요.");
  }, [filtered, from, to, buildCsv, handleExport]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[#E4DED2] bg-white p-4 space-y-3">
        <div className="text-sm font-semibold text-[#22301F]">기간 선택</div>
        <div className="flex items-center gap-2 text-sm">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-[#D8D0BE] rounded-lg px-2 py-1.5 text-xs font-mono flex-1" />
          <span className="text-[#8A8172]">~</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-[#D8D0BE] rounded-lg px-2 py-1.5 text-xs font-mono flex-1" />
        </div>
        <div className="text-xs text-[#8A8172]">{filtered.length}건의 세션이 포함됩니다.</div>
        <button onClick={handleShare} className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#22301F] text-white text-sm font-medium py-2.5 hover:bg-[#2E401F]">
          <FileDown size={16} /> 공유하기 (카카오톡·이메일 등)
        </button>
        <button onClick={handleExport} className="w-full flex items-center justify-center gap-2 rounded-xl border border-[#D8D0BE] text-[#5B5646] text-sm font-medium py-2 hover:bg-[#FAF7EF]">
          CSV 파일만 다운로드
        </button>
        {msg && <div className="text-xs text-[#5B5646] text-center">{msg}</div>}
      </div>
      <div className="text-[11px] text-[#A79F8E] leading-relaxed px-1">
        CSV에는 이름·전화번호 등 개인정보가 기본 포함되지 않습니다. "공유하기"는 기기의 Web Share API를 사용해 카카오톡·이메일 등 OS 공유 시트를 직접 띄우고, 지원하지 않는 브라우저에서는 자동으로 다운로드로 대체됩니다.
      </div>
    </div>
  );
}

/* ---------------------------- 프로필 설정 ---------------------------- */
function SetupScreen({ profile, setProfile, mode, setMode, onDone }) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-[#5B5646] leading-relaxed">
        신체 스펙과 감량 모드를 입력하면, 플레이트가 계산할 끼니 목표 칼로리를 앱에서도 미리 확인할 수 있어요.
      </div>
      <div className="rounded-2xl border border-[#E4DED2] bg-white p-4 grid grid-cols-2 gap-3">
        <label className="text-xs text-[#8A8172] col-span-2">
          성별
          <div className="flex gap-2 mt-1">
            {["female", "male"].map((g) => (
              <button
                key={g}
                onClick={() => setProfile((p) => ({ ...p, gender: g }))}
                className={`flex-1 rounded-lg py-1.5 text-sm font-medium border ${profile.gender === g ? "bg-[#22301F] text-white border-[#22301F]" : "border-[#D8D0BE] text-[#5B5646]"}`}
              >
                {g === "female" ? "여성" : "남성"}
              </button>
            ))}
          </div>
        </label>
        <label className="text-xs text-[#8A8172]">
          키(cm)
          <input type="number" value={profile.height} onChange={(e) => setProfile((p) => ({ ...p, height: +e.target.value }))} className="mt-1 w-full border border-[#D8D0BE] rounded-lg px-2 py-1.5 text-sm font-mono" />
        </label>
        <label className="text-xs text-[#8A8172]">
          나이
          <input type="number" value={profile.age} onChange={(e) => setProfile((p) => ({ ...p, age: +e.target.value }))} className="mt-1 w-full border border-[#D8D0BE] rounded-lg px-2 py-1.5 text-sm font-mono" />
        </label>
        <label className="text-xs text-[#8A8172] col-span-2">
          체중(kg)
          <input type="number" value={profile.weight} onChange={(e) => setProfile((p) => ({ ...p, weight: +e.target.value }))} className="mt-1 w-full border border-[#D8D0BE] rounded-lg px-2 py-1.5 text-sm font-mono" />
        </label>
      </div>
      <div className="rounded-2xl border border-[#E4DED2] bg-white p-4">
        <div className="text-xs text-[#8A8172] mb-2">감량 모드</div>
        <div className="flex gap-2">
          {[
            { id: "healthy", label: "건강한 감량" },
            { id: "fast", label: "빠른 감량" },
          ].map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`flex-1 rounded-lg py-2 text-sm font-medium border ${mode === m.id ? "bg-[#8CF07A] border-[#8CF07A] text-[#16211C]" : "border-[#D8D0BE] text-[#5B5646]"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-[#A79F8E] mt-2 font-mono">
          예상 끼니 목표 ≈ {calcTargetKcal(profile, mode).toLocaleString()} kcal
        </div>
      </div>
      <button onClick={onDone} className="w-full rounded-xl bg-[#22301F] text-white py-2.5 text-sm font-medium">
        저장하고 시작하기
      </button>
    </div>
  );
}

/* ---------------------------- 초과 섭취 경고 팝업 ---------------------------- */
function ExcessModal({ kcal, onClose }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-6">
      <div
        className="w-full max-w-[260px] rounded-2xl bg-white p-5 text-center space-y-3 shadow-2xl"
        style={{ animation: "modalPop 220ms ease-out" }}
      >
        <AlertTriangle size={30} className="mx-auto text-[#C0503E]" />
        <div className="text-sm font-semibold text-[#22301F] leading-snug">
          칼로리 초과 발생! 저녁 식사량을 조절하세요
        </div>
        <div className="text-xs text-[#8A8172] font-mono">이번 세션 {kcal}kcal 초과 · 게이지 후퇴</div>
        <button onClick={onClose} className="w-full rounded-xl bg-[#22301F] text-white py-2 text-sm font-medium">
          확인
        </button>
      </div>
    </div>
  );
}

/* ---------------------------- 연결 화면 ---------------------------- */
function ConnectBar({ connected, connecting, onConnect, onSimulate }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-[#16211C] px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-[#EFF7F0] text-xs">
        {connected ? <BluetoothConnected size={15} className="text-[#8CF07A]" /> : <Bluetooth size={15} className="text-[#8FAF9B]" />}
        {connecting ? "연결 시도 중…" : connected ? "스마트 플레이트 연결됨" : "플레이트 연결 안 됨"}
      </div>
      {connected ? (
        <button onClick={onSimulate} className="flex items-center gap-1 text-[10px] font-medium bg-[#8CF07A] text-[#16211C] rounded-full px-2.5 py-1">
          <Plus size={12} /> 식사 데이터 수신
        </button>
      ) : (
        <button onClick={onConnect} className="text-[10px] font-medium bg-[#233A2E] text-[#8CF07A] rounded-full px-2.5 py-1">
          {connecting ? "..." : "1탭 연결"}
        </button>
      )}
    </div>
  );
}

/* 실제 시리얼 패킷을 손으로 넣어 파서와 예외 처리를 검증하는 디버그 패널 */
function RawPacketDebugPanel({ onParse, lastError }) {
  const [raw, setRaw] = useState("2026-07-23T18:30:00,healthy,650,610,0,40,없음");
  return (
    <details className="rounded-xl border border-dashed border-[#D8D0BE] bg-white/60 p-3 text-xs">
      <summary className="cursor-pointer text-[#5B5646] font-medium">수동 패킷 입력 (파서/예외 처리 테스트)</summary>
      <div className="mt-2 space-y-2">
        <div className="text-[10px] text-[#A79F8E] font-mono leading-relaxed">
          형식: DATE,MODE,E_TARGET,E_ACTUAL,SPEED_VIOLATION,E_DEFICIT,LEFTOVER_CAT
        </div>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={2}
          className="w-full border border-[#D8D0BE] rounded-lg px-2 py-1.5 text-[11px] font-mono"
        />
        <button
          onClick={() => onParse(raw)}
          className="w-full rounded-lg bg-[#233A2E] text-[#8CF07A] text-[11px] font-medium py-1.5"
        >
          패킷 파싱해서 세션 추가
        </button>
        {lastError && (
          <div className="flex items-start gap-1.5 rounded-lg bg-[#3A2323] text-[#F0968A] px-2 py-1.5 text-[10px]">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> 파싱 실패: {lastError}
          </div>
        )}
      </div>
    </details>
  );
}

/* ---------------------------- 메인 앱 ---------------------------- */
export default function SmartPlateApp() {
  const [profile, setProfile] = useState({ gender: "female", height: 163, age: 21, weight: 58 });
  const [mode, setMode] = useState("healthy");
  const [setupDone, setSetupDone] = useState(false);
  const [tab, setTab] = useState("home");
  const [sessions, setSessions] = useState([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [selectedSession, setSelectedSession] = useState(null);
  const [excessModal, setExcessModal] = useState(null); // { kcal }
  const [gaugeAlert, setGaugeAlert] = useState(false);
  const [rawError, setRawError] = useState(null);

  const handleConnect = () => {
    setConnecting(true);
    setTimeout(() => {
      setConnecting(false);
      setConnected(true);
    }, 900);
  };

  const ingestSession = (s) => {
    setSessions((prev) => [...prev, s]);
    if (s.deficit < 0) {
      setExcessModal({ kcal: Math.abs(s.deficit) });
      setGaugeAlert(true);
      setTimeout(() => setGaugeAlert(false), 1800);
    }
  };

  /* ① 자동 시뮬레이션: 아두이노 원시 패킷 문자열을 만들고, 실제 파서로 해석한다 */
  const receiveSession = () => {
    const raw = simulateIncomingPacket(profile, mode);
    const result = parseSerialPacket(raw);
    if (result.ok) {
      setRawError(null);
      ingestSession(result.session);
    } else {
      // 시뮬레이터 자체 오류(사실상 없어야 함) — 방어적으로 처리
      setRawError(result.error);
    }
  };

  /* ② 수동 입력 패널: 깨진 문자열을 직접 넣어 예외 처리를 확인 */
  const handleRawParse = (raw) => {
    const result = parseSerialPacket(raw);
    if (result.ok) {
      setRawError(null);
      ingestSession(result.session);
    } else {
      setRawError(result.error);
    }
  };

  const sorted = useMemo(() => [...sessions].sort((a, b) => b.timestamp - a.timestamp), [sessions]);

  if (!setupDone) {
    return (
      <PhoneFrame>
        <ScreenHeader title="프로필 설정" />
        <div className="p-4">
          <SetupScreen profile={profile} setProfile={setProfile} mode={mode} setMode={setMode} onDone={() => setSetupDone(true)} />
        </div>
      </PhoneFrame>
    );
  }

  return (
    <PhoneFrame>
      <ScreenHeader
        title={tab === "home" ? "오늘의 기록" : tab === "history" ? "기록 히스토리" : tab === "report" ? "리포트 내보내기" : "설정"}
      />
      <div className="px-4 pt-3">
        <ConnectBar connected={connected} connecting={connecting} onConnect={handleConnect} onSimulate={receiveSession} />
      </div>

      <div className="p-4 space-y-4 overflow-y-auto" style={{ maxHeight: 520 }}>
        {tab === "home" && (
          <>
            <TodaySummary sessions={sessions} />
            <DeficitGauge sessions={sessions} alert={gaugeAlert} />
            <WeeklyChart sessions={sessions} onPickDay={() => setTab("history")} />
            <RawPacketDebugPanel onParse={handleRawParse} lastError={rawError} />
          </>
        )}

        {tab === "history" && !selectedSession && (
          <div className="space-y-2">
            {sorted.length === 0 && (
              <div className="text-center text-xs text-[#A79F8E] py-10">
                아직 기록이 없어요. 상단의 "식사 데이터 수신"으로 세션을 받아보세요.
              </div>
            )}
            {sorted.map((s) => (
              <SessionRow key={s.id} s={s} onClick={() => setSelectedSession(s)} />
            ))}
          </div>
        )}

        {tab === "history" && selectedSession && (
          <SessionDetail s={selectedSession} onBack={() => setSelectedSession(null)} />
        )}

        {tab === "report" && <ReportScreen sessions={sessions} />}

        {tab === "settings" && (
          <SetupScreen profile={profile} setProfile={setProfile} mode={mode} setMode={setMode} onDone={() => setTab("home")} />
        )}
      </div>

      <BottomNav tab={tab} setTab={(t) => { setTab(t); setSelectedSession(null); }} />

      {excessModal && (
        <ExcessModal kcal={excessModal.kcal} onClose={() => setExcessModal(null)} />
      )}
    </PhoneFrame>
  );
}

function ScreenHeader({ title }) {
  return (
    <div className="px-4 pt-4 pb-1 flex items-center gap-2">
      <GaugeIcon size={16} className="text-[#3E7A3A]" />
      <div className="text-[15px] font-semibold text-[#22301F] font-mono tracking-tight">{title}</div>
    </div>
  );
}

function BottomNav({ tab, setTab }) {
  const items = [
    { id: "home", label: "홈", icon: Home },
    { id: "history", label: "기록", icon: History },
    { id: "report", label: "리포트", icon: FileDown },
    { id: "settings", label: "설정", icon: Settings2 },
  ];
  return (
    <div className="grid grid-cols-4 border-t border-[#E4DED2] bg-white">
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => setTab(id)}
          className={`flex flex-col items-center gap-0.5 py-2.5 text-[10px] ${tab === id ? "text-[#22301F] font-semibold" : "text-[#A79F8E]"}`}
        >
          <Icon size={17} />
          {label}
        </button>
      ))}
    </div>
  );
}

function PhoneFrame({ children }) {
  return (
    <div className="min-h-full w-full flex items-center justify-center bg-[#EDE7D8] py-8">
      <style>{`
        @keyframes gaugeFlash {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes modalPop {
          0% { opacity: 0; transform: scale(0.9); }
          100% { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div
        className="relative w-[380px] rounded-[2rem] bg-[#FAF7EF] shadow-2xl border-8 border-[#1B211A] overflow-hidden flex flex-col"
        style={{ height: 720 }}
      >
        {children}
      </div>
    </div>
  );
}
