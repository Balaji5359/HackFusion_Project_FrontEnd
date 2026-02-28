import { useEffect, useMemo, useRef, useState } from 'react'
import { Mic, ShieldCheck, Volume2 } from 'lucide-react'
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import MetricCard from './components/MetricCard'
import TraceTimeline from './components/TraceTimeline'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''
const STT_API_URL = 'https://ibxdsy0e40.execute-api.ap-south-1.amazonaws.com/dev/audiototranscript-api'
const RUNS_STORAGE_KEY = 'agent_runs_v2'
const ADMIN_PASSWORD = 'admin@123'

function nowIso() {
  return new Date().toISOString()
}

function normalizeText(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseIntent(text, medicines = []) {
  const raw = (text || '').trim()
  const normalizedPrompt = normalizeText(raw)
  const quantityMatch = raw.match(/(\d+)/)
  const quantity = quantityMatch ? Number(quantityMatch[1]) : 1

  let medicineName = ''
  let bestLength = -1
  for (const med of medicines || []) {
    const name = med?.medicine_name || ''
    const normName = normalizeText(name)
    if (!normName) continue
    if (normalizedPrompt.includes(normName) && normName.length > bestLength) {
      bestLength = normName.length
      medicineName = name
    }
  }

  if (!medicineName) {
    const stripped = raw
      .replace(/\d+/g, ' ')
      .replace(/order|buy|get|need|want|please/gi, ' ')
      .replace(/ఆర్డర్|చేయండి|కావాలి|లో/gi, ' ')
      .replace(/ऑर्डर|करो|चाहिए/gi, ' ')
      .replace(/ஆர்டர்|செய்யுங்கள்|வேண்டும்/gi, ' ')
      .replace(/ಆರ್ಡರ್|ಮಾಡಿ|ಬೇಕು/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    medicineName = stripped
  }

  return { quantity, medicine_name: medicineName }
}

function seemsLikeOrder(text) {
  const t = (text || '').trim().toLowerCase()
  if (!t) return false
  return /(order|buy|get|need|want)/i.test(t) || /\d+/.test(t)
}

function isGreeting(text) {
  const t = (text || '').trim().toLowerCase()
  return ['hi', 'hello', 'hey', 'namaste', 'thanks', 'thank you'].includes(t)
}

function suggestionScore(medicine, quantity, approved) {
  if (!medicine) return 20
  let s = 40
  if (approved) s += 30
  if (Number(medicine.stock || 0) >= quantity * 2) s += 20
  if (!medicine.requires_prescription) s += 10
  return Math.max(0, Math.min(100, s))
}

export default function App() {
  const [tab, setTab] = useState('user')
  const [adminUnlocked, setAdminUnlocked] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [adminView, setAdminView] = useState('dashboard')

  const [prompt, setPrompt] = useState('')
  const [chatMessages, setChatMessages] = useState([
    { role: 'assistant', text: 'Hello. Tell me your medicine requirement and quantity. I will guide you step by step.', ts: nowIso() },
  ])

  const [loadingRun, setLoadingRun] = useState(false)
  const [runResult, setRunResult] = useState(null)
  const [runHistory, setRunHistory] = useState([])
  const [orders, setOrders] = useState([])
  const [medicines, setMedicines] = useState([])
  const [apiError, setApiError] = useState('')

  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceStatus, setVoiceStatus] = useState('Idle')
  const [isListening, setIsListening] = useState(false)
  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const audioChunksRef = useRef([])
  const chatScrollRef = useRef(null)

  const ensureApiBase = () => {
    if (!API_BASE) throw new Error('Set VITE_API_BASE_URL in react-ui/.env.local')
  }

  const speakText = (text) => {
    if (!('speechSynthesis' in window)) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  }

  const apiGet = async (path) => {
    ensureApiBase()
    const res = await fetch(`${API_BASE}${path}`)
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
    return res.json()
  }

  const apiPost = async (path, body) => {
    ensureApiBase()
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`POST ${path} failed: ${res.status} ${txt}`)
    }
    return res.json()
  }

  const fetchMedicineByName = async (name) => {
    ensureApiBase()
    const res = await fetch(`${API_BASE}/medicine?medicine_name=${encodeURIComponent(name)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GET /medicine failed: ${res.status}`)
    const data = await res.json()
    return data?.found ? data : null
  }

  const refreshData = async () => {
    const [o, m] = await Promise.all([apiGet('/orders'), apiGet('/medicines')])
    setOrders(o.items || [])
    setMedicines(m.items || [])
  }

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = String(reader.result || '')
        const base64 = result.split(',')[1] || ''
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })

  const transcribeAudio = async (audioBlob) => {
    const base64 = await blobToBase64(audioBlob)
    const payload = {
      body: JSON.stringify({ data: base64 }),
      isBase64Encoded: false,
    }
    const res = await fetch(STT_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      throw new Error(`STT API failed: ${res.status}`)
    }
    const outer = await res.json()
    const parsedBody = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body
    return parsedBody?.transcript || ''
  }

  const startVoiceInput = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setApiError('Microphone capture is not supported in this browser.')
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      audioChunksRef.current = []

      const recorder = new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      setIsListening(true)
      setVoiceStatus('Recording...')

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = async () => {
        setIsListening(false)
        setVoiceStatus('Transcribing...')
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          const transcript = await transcribeAudio(audioBlob)
          setVoiceTranscript(transcript)
          setVoiceStatus(transcript ? 'Transcript ready' : 'No speech detected')
        } catch (err) {
          setVoiceStatus('Transcription failed')
          setApiError(`Speech-to-text failed. ${String(err.message || err)}`)
        } finally {
          if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((t) => t.stop())
            mediaStreamRef.current = null
          }
          mediaRecorderRef.current = null
          audioChunksRef.current = []
        }
      }

      recorder.start()
    } catch (err) {
      setIsListening(false)
      setVoiceStatus('Microphone error')
      setApiError(`Unable to start microphone. ${String(err.message || err)}`)
    }
  }

  const stopVoiceInput = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    setVoiceStatus('Stopped')
  }

  const appendRun = (run) => {
    setRunResult(run)
    setRunHistory((prev) => [run, ...prev].slice(0, 200))
  }

  const runAgentChain = async (userPrompt, options = {}) => {
    const { speakReply = false } = options
    setLoadingRun(true)
    setApiError('')
    const start = performance.now()

    try {
      if (isGreeting(userPrompt) || !seemsLikeOrder(userPrompt)) {
        const msg = 'Please share medicine name and quantity so I can process it safely.'
        setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
        if (speakReply) speakText(msg)
        return
      }

      const intent = parseIntent(userPrompt, medicines)
      const medicineName = intent.medicine_name
      const quantity = Number(intent.quantity || 1)
      const timeline = [{ step: 1, stage: 'IntentExtractionAgent', summary: `medicine=${medicineName}, qty=${quantity}` }]

      const medicine = await fetchMedicineByName(medicineName)
      if (!medicine) {
        const run = {
          run_id: crypto.randomUUID(),
          timestamp: nowIso(),
          user_prompt: userPrompt,
          medicine_name: medicineName,
          quantity,
          approved: false,
          db_update_ok: false,
          response: `Medicine '${medicineName}' not found in DynamoDB.`,
          latency_ms: Math.round(performance.now() - start),
          trace_count: 2,
          suggestion_score: 25,
          trace_timeline: [...timeline, { step: 2, stage: 'SafetyPolicyAgent', summary: 'Rejected: medicine not found' }],
        }
        appendRun(run)
        setChatMessages((prev) => [...prev, { role: 'assistant', text: run.response, ts: nowIso() }])
        if (speakReply) speakText(run.response)
        return
      }

      timeline.push({ step: 2, stage: 'SafetyPolicyAgent', summary: `stock=${medicine.stock}, prescription=${medicine.requires_prescription}` })

      if (medicine.requires_prescription) {
        const run = {
          run_id: crypto.randomUUID(),
          timestamp: nowIso(),
          user_prompt: userPrompt,
          medicine_name: medicineName,
          quantity,
          approved: false,
          db_update_ok: false,
          response: `Order rejected: ${medicineName} requires prescription.`,
          latency_ms: Math.round(performance.now() - start),
          trace_count: 3,
          suggestion_score: 35,
          trace_timeline: [...timeline, { step: 3, stage: 'SupervisorAgent', summary: 'Rejected by policy' }],
        }
        appendRun(run)
        setChatMessages((prev) => [...prev, { role: 'assistant', text: run.response, ts: nowIso() }])
        if (speakReply) speakText(run.response)
        return
      }

      if (Number(medicine.stock || 0) < quantity) {
        const run = {
          run_id: crypto.randomUUID(),
          timestamp: nowIso(),
          user_prompt: userPrompt,
          medicine_name: medicineName,
          quantity,
          approved: false,
          db_update_ok: false,
          response: `Order rejected: requested ${quantity}, available ${medicine.stock}.`,
          latency_ms: Math.round(performance.now() - start),
          trace_count: 3,
          suggestion_score: 45,
          trace_timeline: [...timeline, { step: 3, stage: 'SupervisorAgent', summary: 'Rejected by stock' }],
        }
        appendRun(run)
        setChatMessages((prev) => [...prev, { role: 'assistant', text: run.response, ts: nowIso() }])
        if (speakReply) speakText(run.response)
        return
      }

      timeline.push({ step: 3, stage: 'ActionAgent', summary: 'Calling place_order_atomic' })
      const orderResp = await apiPost('/order', { medicine_name: medicineName, quantity })
      const approved = orderResp?.execution_status === 'SUCCESS'
      const run = {
        run_id: crypto.randomUUID(),
        timestamp: nowIso(),
        user_prompt: userPrompt,
        medicine_name: medicineName,
        quantity,
        order_id: orderResp?.order_id || '',
        approved,
        db_update_ok: approved,
        response: approved
          ? `Order placed for ${quantity} ${medicineName}. Order ID: ${orderResp?.order_id || 'N/A'}.`
          : `Order failed: ${orderResp?.reason || 'unknown reason'}`,
        latency_ms: Math.round(performance.now() - start),
        trace_count: 4,
        suggestion_score: suggestionScore(medicine, quantity, approved),
        trace_timeline: [...timeline, { step: 4, stage: 'SupervisorAgent', summary: approved ? 'Committed to DynamoDB' : 'Failed' }],
      }
      appendRun(run)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: run.response, ts: nowIso() }])
      await refreshData()
      if (speakReply) speakText(run.response)
    } catch (e) {
      const msg = `API not reachable or invalid response. ${String(e.message || e)}`
      setApiError(msg)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
      if (speakReply) speakText(msg)
    } finally {
      setLoadingRun(false)
    }
  }

  const onSendPrompt = async () => {
    const text = prompt.trim()
    if (!text) return
    setChatMessages((prev) => [...prev, { role: 'user', text, ts: nowIso() }])
    setPrompt('')
    await runAgentChain(text)
  }

  const onSendVoiceTranscript = async () => {
    const text = voiceTranscript.trim()
    if (!text) return
    setChatMessages((prev) => [...prev, { role: 'user', text, ts: nowIso() }])
    await runAgentChain(text, { speakReply: true })
  }

  const onClearChat = () => {
    setChatMessages([
      {
        role: 'assistant',
        text: 'Chat cleared. Please share medicine name and quantity to continue.',
        ts: nowIso(),
      },
    ])
    setPrompt('')
    setVoiceTranscript('')
    setVoiceStatus('Idle')
    setApiError('')
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(RUNS_STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) setRunHistory(parsed)
      }
    } catch {
      // ignore storage errors
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(runHistory))
  }, [runHistory])

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [chatMessages, loadingRun])

  useEffect(() => {
    ;(async () => {
      try {
        await refreshData()
      } catch (e) {
        setApiError(`Set VITE_API_BASE_URL and ensure API Gateway is deployed. ${String(e.message || e)}`)
      }
    })()
  }, [])

  const latestRun = runResult || runHistory[0]
  const summary = useMemo(() => {
    if (!runHistory.length) return { total_runs: 0, success_rate: 0, avg_latency_ms: 0, avg_suggestion_score: 0 }
    const total = runHistory.length
    const approved = runHistory.filter((r) => r.approved).length
    const avgLatency = Math.round(runHistory.reduce((a, r) => a + Number(r.latency_ms || 0), 0) / total)
    const avgScore = Math.round(runHistory.reduce((a, r) => a + Number(r.suggestion_score || 0), 0) / total)
    return {
      total_runs: total,
      success_rate: Number(((approved / total) * 100).toFixed(1)),
      avg_latency_ms: avgLatency,
      avg_suggestion_score: avgScore,
    }
  }, [runHistory])

  const approvalPie = useMemo(() => {
    const approved = runHistory.filter((r) => r.approved).length
    const rejected = runHistory.length - approved
    return [
      { name: 'Approved', value: approved, color: '#16a34a' },
      { name: 'Rejected', value: rejected, color: '#ef4444' },
    ]
  }, [runHistory])

  const topMedicines = useMemo(() => {
    const map = {}
    for (const o of orders) map[o.medicine_name || 'Unknown'] = (map[o.medicine_name || 'Unknown'] || 0) + 1
    return Object.entries(map)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [orders])

  const totalStock = medicines.reduce((acc, m) => acc + Number(m.stock || 0), 0)
  const latestTrace = latestRun?.trace_timeline || []
  const securityLayers = [
    {
      name: 'L1 Input Guard',
      status: latestRun?.user_prompt ? 'PASS' : 'PENDING',
      detail: 'Prompt normalization and intent extraction executed.',
    },
    {
      name: 'L2 Policy Gate',
      status: latestTrace.length >= 2 ? 'PASS' : 'PENDING',
      detail: 'Safety policy validates stock and prescription constraints.',
    },
    {
      name: 'L3 Atomic Commit',
      status: latestRun?.approved ? (latestRun?.db_update_ok ? 'PASS' : 'FAIL') : 'N/A',
      detail: 'Order + stock update commit through atomic transaction.',
    },
  ]

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="max-w-7xl mx-auto space-y-5">
        <header className="panel p-5 md:p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <p className="text-xs tracking-[0.2em] uppercase text-sky-700 font-semibold">Hackfusion Agentic AI</p>
              <h1 className="text-2xl md:text-3xl font-bold">Agentic Pharmacy Control Tower</h1>
              <p className="text-slate-600 mt-1">English-only assistant with live traceability and database-backed actions.</p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button onClick={() => setTab('user')} className={`px-4 py-2 rounded-xl border ${tab === 'user' ? 'bg-slate-900 text-white' : 'bg-white'}`}>User Workspace</button>
              <button onClick={() => setTab('admin')} className={`px-4 py-2 rounded-xl border ${tab === 'admin' ? 'bg-slate-900 text-white' : 'bg-white'}`}>Admin Control</button>
            </div>
          </div>
          {apiError && <p className="text-red-600 mt-3 text-sm">{apiError}</p>}
        </header>

        {tab === 'user' && (
          <section className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard title="Latency" value={`${latestRun?.latency_ms ?? summary.avg_latency_ms} ms`} tone="latency" />
              <MetricCard title="Trace Events" value={String(latestRun?.trace_count ?? 0)} tone="traces" />
              <MetricCard title="Suggestion Score" value={`${latestRun?.suggestion_score ?? summary.avg_suggestion_score}/100`} tone="score" />
              <MetricCard title="Decision" value={latestRun ? (latestRun.approved ? 'APPROVED' : 'REJECTED') : 'N/A'} tone="success" />
            </div>

            <div className="grid lg:grid-cols-12 gap-4">
              <div className="lg:col-span-8 space-y-4">
                <div className="panel p-4 md:p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xl font-semibold">AI Assistant</h3>
                    <span className="text-xs font-medium px-2 py-1 rounded-full bg-sky-100 text-sky-800 border border-sky-200">
                      Explainable + Traceable
                    </span>
                  </div>

                  <div ref={chatScrollRef} className="fast-scroll rounded-xl border border-slate-200 bg-slate-50 p-4 h-[28rem] overflow-auto mb-3 space-y-2">
                    {chatMessages.map((m, idx) => (
                      <div key={`${m.ts}-${idx}`} className={`max-w-[90%] rounded-xl px-4 py-3 text-sm ${m.role === 'user' ? 'ml-auto bg-sky-600 text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-800 shadow-sm'}`}>
                        {m.text}
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2 mb-3">
                    <input
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') onSendPrompt() }}
                      className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm"
                      placeholder="Type your medicine request..."
                    />
                    <button onClick={onSendPrompt} disabled={loadingRun} className="rounded-xl bg-sky-600 hover:bg-sky-700 text-white px-4 py-3 text-sm font-semibold disabled:opacity-50">
                      {loadingRun ? 'Running...' : 'Send'}
                    </button>
                  </div>

                  <textarea value={voiceTranscript} onChange={(e) => setVoiceTranscript(e.target.value)} rows={3} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm mb-3" placeholder="Speech transcript..." />

                  <div className="flex flex-wrap gap-2">
                  <button onClick={startVoiceInput} className={`rounded-xl px-4 py-2 text-sm font-semibold border ${isListening ? 'bg-amber-100 border-amber-300 text-amber-900' : 'bg-white'}`}><Mic className="h-4 w-4 inline mr-1" /> {isListening ? 'Listening...' : 'Start Listening'}</button>
                  <button onClick={stopVoiceInput} className="rounded-xl px-4 py-2 text-sm font-semibold border bg-white">Stop</button>
                  <button onClick={onSendVoiceTranscript} disabled={loadingRun || !voiceTranscript.trim()} className="rounded-xl bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50">Send Voice to AI</button>
                  <button onClick={onClearChat} className="rounded-xl px-4 py-2 text-sm font-semibold border bg-white">Clear Chat</button>
                  <button onClick={() => speakText(voiceTranscript || 'Voice assistant ready')} className="rounded-xl px-4 py-2 text-sm font-semibold border bg-white"><Volume2 className="h-4 w-4 inline mr-1" /> Test Voice</button>
                </div>
              </div>

                <div className="panel p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <ShieldCheck className="h-5 w-5 text-emerald-600" />
                    <h3 className="text-lg font-semibold">Security Layers</h3>
                  </div>
                  <div className="grid md:grid-cols-3 gap-3">
                    {securityLayers.map((layer) => (
                      <div key={layer.name} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold text-slate-800">{layer.name}</p>
                          <span
                            className={`text-xs font-semibold px-2 py-1 rounded-full border ${
                              layer.status === 'PASS'
                                ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                                : layer.status === 'FAIL'
                                  ? 'bg-rose-100 text-rose-700 border-rose-200'
                                  : 'bg-amber-100 text-amber-700 border-amber-200'
                            }`}
                          >
                            {layer.status}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 mt-1">{layer.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="lg:col-span-4 space-y-4">
                <TraceTimeline events={latestRun?.trace_timeline || []} />
              </div>
            </div>
          </section>
        )}

        {tab === 'admin' && (
          <section className="space-y-4">
            {!adminUnlocked ? (
              <div className="panel p-5 max-w-md">
                <h3 className="text-lg font-semibold mb-2">Admin Login</h3>
                <input type="password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm mb-2" placeholder="Enter admin password" />
                <button onClick={() => setAdminUnlocked(passwordInput === ADMIN_PASSWORD)} className="rounded-xl bg-slate-900 text-white px-4 py-3 text-sm font-semibold">Unlock Dashboard</button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setAdminView('dashboard')} className={`px-3 py-2 rounded-lg border ${adminView === 'dashboard' ? 'bg-slate-900 text-white' : 'bg-white'}`}>Admin Dashboard</button>
                  <button onClick={() => setAdminView('orders')} className={`px-3 py-2 rounded-lg border ${adminView === 'orders' ? 'bg-slate-900 text-white' : 'bg-white'}`}>Orders</button>
                  <button onClick={() => setAdminView('inventory')} className={`px-3 py-2 rounded-lg border ${adminView === 'inventory' ? 'bg-slate-900 text-white' : 'bg-white'}`}>Inventory</button>
                  <button onClick={refreshData} className="px-3 py-2 rounded-lg border bg-white">Refresh</button>
                </div>

                {adminView === 'dashboard' && (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <MetricCard title="Total Runs" value={String(summary.total_runs)} tone="traces" />
                      <MetricCard title="Success Rate" value={`${summary.success_rate}%`} tone="success" />
                      <MetricCard title="Avg Latency" value={`${summary.avg_latency_ms} ms`} tone="latency" />
                      <MetricCard title="Avg Suggestion" value={`${summary.avg_suggestion_score}/100`} tone="score" />
                    </div>
                    <div className="grid lg:grid-cols-2 gap-4">
                      <div className="panel p-4 h-80">
                        <h3 className="text-lg font-semibold mb-3">Approval Split</h3>
                        <ResponsiveContainer width="100%" height="85%">
                          <PieChart>
                            <Pie data={approvalPie} dataKey="value" nameKey="name" outerRadius={100} innerRadius={55}>
                              {approvalPie.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                            </Pie>
                            <Tooltip />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="panel p-4 h-80">
                        <h3 className="text-lg font-semibold mb-3">Top Medicines</h3>
                        <ResponsiveContainer width="100%" height="85%">
                          <BarChart data={topMedicines}>
                            <XAxis dataKey="name" hide />
                            <YAxis />
                            <Tooltip />
                            <Bar dataKey="count" fill="#0284c7" radius={[8, 8, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </>
                )}

                {adminView === 'orders' && (
                  <div className="panel p-4 overflow-auto">
                    <h3 className="text-lg font-semibold mb-3">Orders (DynamoDB)</h3>
                    <p className="text-sm text-slate-600 mb-2">Total orders: {orders.length}</p>
                    <table className="w-full text-sm">
                      <thead><tr className="text-left border-b">{(orders[0] ? Object.keys(orders[0]) : []).map((k) => <th key={k} className="py-2 pr-3">{k}</th>)}</tr></thead>
                      <tbody>{orders.map((o, i) => <tr key={o.order_id || i} className="border-b border-slate-100">{(orders[0] ? Object.keys(orders[0]) : []).map((k) => <td key={`${i}-${k}`} className="py-2 pr-3">{String(o[k] ?? '')}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                )}

                {adminView === 'inventory' && (
                  <div className="panel p-4 overflow-auto">
                    <h3 className="text-lg font-semibold mb-3">Medicines (DynamoDB)</h3>
                    <p className="text-sm text-slate-600 mb-2">Total stock: {totalStock}</p>
                    <table className="w-full text-sm">
                      <thead><tr className="text-left border-b">{(medicines[0] ? Object.keys(medicines[0]) : []).map((k) => <th key={k} className="py-2 pr-3">{k}</th>)}</tr></thead>
                      <tbody>{medicines.map((m, i) => <tr key={m.medicine_name || i} className="border-b border-slate-100">{(medicines[0] ? Object.keys(medicines[0]) : []).map((k) => <td key={`${i}-${k}`} className="py-2 pr-3">{String(m[k] ?? '')}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>

    </div>
  )
}

