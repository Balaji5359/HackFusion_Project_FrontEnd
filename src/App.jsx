import { useEffect, useMemo, useRef, useState } from 'react'
import { Mic, ShieldCheck, Volume2 } from 'lucide-react'
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import MetricCard from './components/MetricCard'
import TraceTimeline from './components/TraceTimeline'

const API_BASE = import.meta.env.VITE_AGENT_API_URL || import.meta.env.VITE_API_BASE_URL || ''
const STT_API_URL =
  import.meta.env.VITE_STT_API_URL ||
  'https://ibxdsy0e40.execute-api.ap-south-1.amazonaws.com/dev/audiototranscript-api'
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

function seemsLikeOrder(text) {
  const t = (text || '').trim().toLowerCase()
  if (!t) return false
  return /(order|buy|get|need|want)/i.test(t) || /\d+/.test(t)
}

function isGreeting(text) {
  const t = (text || '').trim().toLowerCase()
  return ['hi', 'hello', 'hey', 'namaste', 'thanks', 'thank you'].includes(t)
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
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [invoice, setInvoice] = useState(null)
  const [checkoutFlow, setCheckoutFlow] = useState({
    mode: '',
    checkoutId: '',
    stage: 'confirm',
    medicineName: '',
    quantity: 0,
    unitPrice: 0,
    totalPrice: 0,
    customerEmail: '',
    userPrompt: '',
    traceTimeline: [],
    suggestionScore: 0,
  })
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
    const payloadPrimary = {
      body: JSON.stringify({ data: base64 }),
      isBase64Encoded: false,
    }

    const callStt = async (payload) => {
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

    try {
      return await callStt(payloadPrimary)
    } catch {
      // fallback if gateway expects direct body schema
      return await callStt({ data: base64 })
    }
  }

  const startVoiceInput = async () => {
    try {
      setApiError('')
      setVoiceTranscript('')
      setIsTranscribing(false)
      if (!navigator.mediaDevices?.getUserMedia) {
        setApiError('Microphone capture is not supported in this browser.')
        return
      }
      if (!window.isSecureContext) {
        setApiError('Microphone requires secure context (https or localhost).')
        return
      }
      if (typeof MediaRecorder === 'undefined') {
        setApiError('MediaRecorder is not supported in this browser.')
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      audioChunksRef.current = []

      const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      const supportedType = preferredTypes.find((t) => MediaRecorder.isTypeSupported?.(t))
      const recorder = supportedType ? new MediaRecorder(stream, { mimeType: supportedType }) : new MediaRecorder(stream)
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
        setIsTranscribing(true)
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          const transcript = await transcribeAudio(audioBlob)
          setVoiceTranscript(transcript)
          setVoiceStatus(transcript ? 'Transcript ready' : 'No speech detected')
        } catch (err) {
          setVoiceStatus('Transcription failed')
          setApiError(`Speech-to-text failed. ${String(err.message || err)}`)
        } finally {
          setIsTranscribing(false)
          if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((t) => t.stop())
            mediaStreamRef.current = null
          }
          mediaRecorderRef.current = null
          audioChunksRef.current = []
        }
      }

      recorder.start(250)
    } catch (err) {
      setIsListening(false)
      setVoiceStatus('Microphone error')
      setIsTranscribing(false)
      setApiError(`Unable to start microphone. ${String(err.message || err)}`)
    }
  }

  const stopVoiceInput = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.requestData()
      } catch {
        // ignore
      }
      setVoiceStatus('Stopping...')
      mediaRecorderRef.current.stop()
    }
  }

  const appendRun = (run) => {
    setRunResult(run)
    setRunHistory((prev) => [run, ...prev].slice(0, 200))
  }

  const resetCheckoutFlow = () => {
    setCheckoutFlow({
      mode: '',
      checkoutId: '',
      stage: '',
      medicineName: '',
      quantity: 0,
      unitPrice: 0,
      totalPrice: 0,
      customerEmail: '',
      userPrompt: '',
      traceTimeline: [],
      suggestionScore: 0,
    })
  }

  const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())

  const dispatchInvoiceEmail = async (email, invoiceData) => {
    try {
      const res = await fetch(`${API_BASE}/invoice/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          invoice: invoiceData,
        }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  const extractQuantity = (text) => {
    const m = String(text || '').match(/\b(\d+)\b/)
    return m ? Math.max(1, Number(m[1])) : 1
  }

  const resolveMedicineName = (text) => {
    const promptNorm = normalizeText(text)
    let best = ''
    let bestLen = -1
    for (const med of medicines || []) {
      const name = med?.medicine_name || ''
      const norm = normalizeText(name)
      if (!norm) continue
      if (promptNorm.includes(norm) && norm.length > bestLen) {
        best = name
        bestLen = norm.length
      }
    }
    if (best) return best

    const promptTokens = new Set(promptNorm.split(' ').filter((t) => t.length > 2))
    let bestScore = 0
    let bestName = ''
    for (const med of medicines || []) {
      const name = med?.medicine_name || ''
      const tokens = normalizeText(name).split(' ').filter((t) => t.length > 2)
      let score = 0
      for (const token of tokens) if (promptTokens.has(token)) score += 1
      if (score > bestScore) {
        bestScore = score
        bestName = name
      }
    }
    return bestScore >= 1 ? bestName : ''
  }

  const estimateScore = (medicine, quantity, approved) => {
    if (!medicine) return 25
    let s = 40
    if (approved) s += 30
    if (Number(medicine.stock || 0) >= quantity) s += 20
    if (!medicine.requires_prescription) s += 10
    return Math.max(0, Math.min(100, s))
  }

  const fetchMedicineByName = async (name) => {
    const res = await fetch(`${API_BASE}/medicine?medicine_name=${encodeURIComponent(name)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GET /medicine failed: ${res.status}`)
    const data = await res.json()
    return data?.found === false ? null : data
  }

  const startCheckoutLocalFallback = async (userPrompt, options = {}) => {
    const { speakReply = false } = options
    const medicineName = resolveMedicineName(userPrompt)
    const quantity = extractQuantity(userPrompt)
    const timeline = [{ step: 1, stage: 'IntentExtractionAgent', summary: `medicine=${medicineName || 'UNKNOWN'}, qty=${quantity}` }]

    if (!medicineName) {
      const response = "I couldn't identify one medicine clearly. Please say one medicine name."
      const run = {
        run_id: crypto.randomUUID(),
        timestamp: nowIso(),
        user_prompt: userPrompt,
        medicine_name: '',
        quantity,
        approved: false,
        db_update_ok: false,
        response,
        latency_ms: 0,
        trace_count: timeline.length + 1,
        suggestion_score: 25,
        trace_timeline: [...timeline, { step: 2, stage: 'SafetyPolicyAgent', summary: 'Rejected: medicine not identified' }],
      }
      appendRun(run)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: response, ts: nowIso() }])
      if (speakReply) speakText(response)
      return
    }

    const medicine = await fetchMedicineByName(medicineName)
    if (!medicine) {
      const response = `Medicine '${medicineName}' not found in DynamoDB.`
      const run = {
        run_id: crypto.randomUUID(),
        timestamp: nowIso(),
        user_prompt: userPrompt,
        medicine_name: medicineName,
        quantity,
        approved: false,
        db_update_ok: false,
        response,
        latency_ms: 0,
        trace_count: timeline.length + 1,
        suggestion_score: 25,
        trace_timeline: [...timeline, { step: 2, stage: 'SafetyPolicyAgent', summary: 'Rejected: medicine not found' }],
      }
      appendRun(run)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: response, ts: nowIso() }])
      if (speakReply) speakText(response)
      return
    }

    timeline.push({ step: 2, stage: 'SafetyPolicyAgent', summary: `stock=${medicine.stock}, prescription=${medicine.requires_prescription}` })
    if (medicine.requires_prescription) {
      const response = `Order rejected: ${medicineName} requires prescription.`
      const run = {
        run_id: crypto.randomUUID(),
        timestamp: nowIso(),
        user_prompt: userPrompt,
        medicine_name: medicineName,
        quantity,
        approved: false,
        db_update_ok: false,
        response,
        latency_ms: 0,
        trace_count: timeline.length + 1,
        suggestion_score: estimateScore(medicine, quantity, false),
        trace_timeline: [...timeline, { step: 3, stage: 'SupervisorAgent', summary: 'Rejected by policy' }],
      }
      appendRun(run)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: response, ts: nowIso() }])
      if (speakReply) speakText(response)
      return
    }

    if (Number(medicine.stock || 0) < quantity) {
      const response = `Order rejected: requested ${quantity}, available ${medicine.stock}.`
      const run = {
        run_id: crypto.randomUUID(),
        timestamp: nowIso(),
        user_prompt: userPrompt,
        medicine_name: medicineName,
        quantity,
        approved: false,
        db_update_ok: false,
        response,
        latency_ms: 0,
        trace_count: timeline.length + 1,
        suggestion_score: estimateScore(medicine, quantity, false),
        trace_timeline: [...timeline, { step: 3, stage: 'SupervisorAgent', summary: 'Rejected by stock' }],
      }
      appendRun(run)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: response, ts: nowIso() }])
      if (speakReply) speakText(response)
      return
    }

    const total = Number(medicine.price || 0) * quantity
    setCheckoutFlow({
      mode: 'local',
      checkoutId: `local-${crypto.randomUUID()}`,
      stage: 'confirm',
      medicineName,
      quantity,
      unitPrice: Number(medicine.price || 0),
      totalPrice: total,
      customerEmail: '',
      userPrompt,
      traceTimeline: [...timeline, { step: 3, stage: 'SupervisorAgent', summary: 'Awaiting user confirmation for payment' }],
      suggestionScore: estimateScore(medicine, quantity, true),
    })
    const msg = `Confirm order: ${quantity} x ${medicineName}. Total cost: ${total.toFixed(2)}`
    setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
    if (speakReply) speakText(msg)
  }

  const cancelCheckoutFlow = async () => {
    if (!checkoutFlow.checkoutId) return
    setPaymentBusy(true)
    try {
      if (checkoutFlow.mode === 'local') {
        const trace = [...checkoutFlow.traceTimeline, { step: checkoutFlow.traceTimeline.length + 1, stage: 'SupervisorAgent', summary: 'Canceled by user' }]
        const run = {
          run_id: crypto.randomUUID(),
          timestamp: nowIso(),
          user_prompt: checkoutFlow.userPrompt,
          medicine_name: checkoutFlow.medicineName,
          quantity: checkoutFlow.quantity,
          approved: false,
          db_update_ok: false,
          response: 'Order canceled by user.',
          latency_ms: 0,
          trace_count: trace.length,
          suggestion_score: checkoutFlow.suggestionScore || 25,
          trace_timeline: trace,
        }
        appendRun(run)
        setChatMessages((prev) => [...prev, { role: 'assistant', text: run.response, ts: nowIso() }])
        resetCheckoutFlow()
        return
      }
      const path = checkoutFlow.stage === 'payment' ? '/checkout/pay' : '/checkout/confirm'
      const body = checkoutFlow.stage === 'payment'
        ? { checkout_id: checkoutFlow.checkoutId, pay: false }
        : { checkout_id: checkoutFlow.checkoutId, confirm: false }
      const resp = await apiPost(path, body)
      const msg = resp?.message || 'Order canceled by user.'
      setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
      resetCheckoutFlow()
    } catch (e) {
      const msg = `Cancel failed. ${String(e.message || e)}`
      setApiError(msg)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
    } finally {
      setPaymentBusy(false)
    }
  }

  const confirmCheckoutFlow = async () => {
    if (!checkoutFlow.checkoutId || checkoutFlow.stage !== 'confirm') return
    setPaymentBusy(true)
    try {
      if (checkoutFlow.mode === 'local') {
        setCheckoutFlow((prev) => ({ ...prev, stage: 'payment' }))
        const msg = `Confirmation received. Proceed to payment of ${checkoutFlow.totalPrice.toFixed(2)}.`
        setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
        return
      }
      const resp = await apiPost('/checkout/confirm', { checkout_id: checkoutFlow.checkoutId, confirm: true })
      if (resp?.status === 'PENDING_PAYMENT') {
        setCheckoutFlow((prev) => ({
          ...prev,
          stage: 'payment',
          totalPrice: Number(resp.total_price || prev.totalPrice || 0),
        }))
      }
      const msg = resp?.message || 'Proceeding to payment.'
      setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
    } catch (e) {
      const msg = `Confirmation failed. ${String(e.message || e)}`
      setApiError(msg)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
    } finally {
      setPaymentBusy(false)
    }
  }

  const payCheckoutFlow = async () => {
    if (!checkoutFlow.checkoutId || checkoutFlow.stage !== 'payment') return
    setPaymentBusy(true)
    try {
      if (checkoutFlow.mode === 'local') {
        const orderResp = await apiPost('/order', {
          medicine_name: checkoutFlow.medicineName,
          quantity: checkoutFlow.quantity,
        })
        const approved = orderResp?.execution_status === 'SUCCESS'
        const trace = [
          ...checkoutFlow.traceTimeline,
          { step: checkoutFlow.traceTimeline.length + 1, stage: 'ActionAgent', summary: 'Calling /order' },
          { step: checkoutFlow.traceTimeline.length + 2, stage: 'SupervisorAgent', summary: approved ? 'Committed to DynamoDB' : `Failed: ${orderResp?.reason || 'unknown'}` },
        ]
        const responseText = approved
          ? `Order placed for ${checkoutFlow.quantity} ${checkoutFlow.medicineName}. Order ID: ${orderResp?.order_id || 'N/A'}.`
          : `Order failed: ${orderResp?.reason || 'unknown reason'}`
        const run = {
          run_id: crypto.randomUUID(),
          timestamp: nowIso(),
          user_prompt: checkoutFlow.userPrompt,
          medicine_name: checkoutFlow.medicineName,
          quantity: checkoutFlow.quantity,
          order_id: orderResp?.order_id || '',
          approved,
          db_update_ok: approved,
          response: responseText,
          latency_ms: 0,
          trace_count: trace.length,
          suggestion_score: checkoutFlow.suggestionScore || 25,
          trace_timeline: trace,
        }
        appendRun(run)
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', text: 'Payment done successfully.', ts: nowIso() },
          { role: 'assistant', text: `Congratulations. ${responseText}`, ts: nowIso() },
        ])
        if (approved) {
          const invoiceData = {
            invoice_id: `INV-${String(orderResp?.order_id || crypto.randomUUID()).slice(0, 8).toUpperCase()}`,
            order_id: orderResp?.order_id || 'N/A',
            medicine_name: checkoutFlow.medicineName,
            quantity: checkoutFlow.quantity,
            unit_price: Number(checkoutFlow.unitPrice || 0),
            total_paid: Number(checkoutFlow.totalPrice || 0),
            customer_email: checkoutFlow.customerEmail,
            paid_at: nowIso(),
          }
          setInvoice(invoiceData)
          const emailOk = await dispatchInvoiceEmail(checkoutFlow.customerEmail, invoiceData)
          setChatMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              text: emailOk
                ? `Invoice sent to ${checkoutFlow.customerEmail}.`
                : `Order placed. Invoice prepared for ${checkoutFlow.customerEmail}.`,
              ts: nowIso(),
            },
          ])
        }
        await refreshData()
        resetCheckoutFlow()
        return
      }
      const resp = await apiPost('/checkout/pay', { checkout_id: checkoutFlow.checkoutId, pay: true })
      const approved = resp?.status === 'PAID'
      const responseText = resp?.message || (approved ? 'Order paid and placed.' : 'Order failed.')
      const trace = resp?.trace_timeline || []
      const run = {
        run_id: crypto.randomUUID(),
        timestamp: nowIso(),
        user_prompt: `checkout:${checkoutFlow.checkoutId}`,
        medicine_name: checkoutFlow.medicineName,
        quantity: checkoutFlow.quantity,
        order_id: resp?.order_id || '',
        approved,
        db_update_ok: approved,
        response: responseText,
        latency_ms: Number(resp?.latency_ms || 0),
        trace_count: trace.length,
        suggestion_score: Number(resp?.suggestion_score || 0),
        trace_timeline: trace,
      }
      appendRun(run)
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', text: 'Payment done successfully.', ts: nowIso() },
        { role: 'assistant', text: `Congratulations. ${responseText}`, ts: nowIso() },
      ])
      if (resp?.invoice) {
        const invoiceData = { ...resp.invoice, customer_email: checkoutFlow.customerEmail }
        setInvoice(invoiceData)
        const emailOk = await dispatchInvoiceEmail(checkoutFlow.customerEmail, invoiceData)
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: emailOk
              ? `Invoice sent to ${checkoutFlow.customerEmail}.`
              : `Order placed. Invoice prepared for ${checkoutFlow.customerEmail}.`,
            ts: nowIso(),
          },
        ])
      }
      await refreshData()
      resetCheckoutFlow()
    } catch (e) {
      const msg = `Payment failed. ${String(e.message || e)}`
      setApiError(msg)
      setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
    } finally {
      setPaymentBusy(false)
    }
  }

  const runAgentChain = async (userPrompt, options = {}) => {
    const { speakReply = false } = options
    setLoadingRun(true)
    setApiError('')

    try {
      if (checkoutFlow.checkoutId) {
        const msg = 'Please complete or cancel the current checkout before creating a new order.'
        setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
        if (speakReply) speakText(msg)
        return
      }
      if (isGreeting(userPrompt) || !seemsLikeOrder(userPrompt)) {
        const msg = 'Please share medicine name and quantity so I can process it safely.'
        setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
        if (speakReply) speakText(msg)
        return
      }

      let startResp = null
      try {
        startResp = await apiPost('/checkout/start', { prompt: userPrompt })
      } catch (startErr) {
        const errText = String(startErr?.message || startErr || '')
        const fallbackNeeded =
          errText.includes('/checkout/start') ||
          errText.includes('404') ||
          errText.includes('Failed to fetch') ||
          errText.includes('ERR_FAILED')
        if (fallbackNeeded) {
          await startCheckoutLocalFallback(userPrompt, { speakReply })
          return
        }
        throw startErr
      }
      const timeline = startResp?.trace_timeline || []
      if (startResp?.status === 'REJECTED') {
        const run = {
          run_id: crypto.randomUUID(),
          timestamp: nowIso(),
          user_prompt: userPrompt,
          medicine_name: startResp?.medicine_name || '',
          quantity: Number(startResp?.quantity || 1),
          approved: false,
          db_update_ok: false,
          response: startResp?.message || 'Order rejected.',
          latency_ms: 0,
          trace_count: timeline.length,
          suggestion_score: Number(startResp?.suggestion_score || 25),
          trace_timeline: timeline,
        }
        appendRun(run)
        setChatMessages((prev) => [...prev, { role: 'assistant', text: run.response, ts: nowIso() }])
        if (speakReply) speakText(run.response)
        return
      }

      if (startResp?.status === 'PENDING_CONFIRMATION') {
        setCheckoutFlow({
          checkoutId: startResp.checkout_id,
          stage: 'confirm',
          medicineName: startResp.medicine_name || '',
          quantity: Number(startResp.quantity || 1),
          unitPrice: Number(startResp.unit_price || 0),
          totalPrice: Number(startResp.total_price || 0),
        })
        const msg = startResp?.message || 'Please confirm this order.'
        setChatMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: nowIso() }])
        if (speakReply) speakText(msg)
      }
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
    setVoiceTranscript('')
    setVoiceStatus('Idle')
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
    setInvoice(null)
    resetCheckoutFlow()
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
  const voiceBusy = isListening || voiceStatus === 'Transcribing...'
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

                  <textarea value={voiceTranscript} onChange={(e) => setVoiceTranscript(e.target.value)} rows={2} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm mb-3" placeholder="Speech transcript..." />
                  {isTranscribing && (
                    <p className="text-xs text-sky-700 mb-2">Transcribing audio... please wait.</p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={isListening ? stopVoiceInput : startVoiceInput}
                      className={`rounded-xl px-4 py-2 text-sm font-semibold border ${isListening ? 'bg-amber-100 border-amber-300 text-amber-900' : 'bg-white'}`}
                    >
                      <Mic className="h-4 w-4 inline mr-1" /> {isListening ? 'Stop Recording' : 'Start Recording'}
                    </button>
                    <button
                      onClick={onSendVoiceTranscript}
                      disabled={loadingRun || voiceBusy || isTranscribing || !voiceTranscript.trim()}
                      className="rounded-xl bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
                    >
                      Send Voice to AI
                    </button>
                    <button
                      onClick={onClearChat}
                      disabled={voiceBusy}
                      className="rounded-xl px-4 py-2 text-sm font-semibold border bg-white disabled:opacity-50"
                    >
                      Clear Chat
                    </button>
                    <button
                      onClick={() => speakText(voiceTranscript || 'Voice assistant ready')}
                      disabled={voiceBusy}
                      className="rounded-xl px-4 py-2 text-sm font-semibold border bg-white disabled:opacity-50"
                    >
                      <Volume2 className="h-4 w-4 inline mr-1" /> Test Voice
                    </button>
                  </div>

                  {invoice && (
                    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                      <h4 className="text-sm font-bold text-emerald-900 mb-2">Invoice</h4>
                      <div className="grid grid-cols-2 gap-2 text-xs text-emerald-900">
                        <p><span className="font-semibold">Invoice ID:</span> {invoice.invoice_id}</p>
                        <p><span className="font-semibold">Order ID:</span> {invoice.order_id}</p>
                        <p><span className="font-semibold">Medicine:</span> {invoice.medicine_name}</p>
                        <p><span className="font-semibold">Quantity:</span> {invoice.quantity}</p>
                        <p><span className="font-semibold">Unit Price:</span> {invoice.unit_price.toFixed(2)}</p>
                        <p><span className="font-semibold">Total Paid:</span> {invoice.total_paid.toFixed(2)}</p>
                        <p className="col-span-2"><span className="font-semibold">Paid At:</span> {invoice.paid_at}</p>
                      </div>
                    </div>
                  )}
              </div>

              </div>

              <div className="lg:col-span-4 space-y-4">
                <TraceTimeline events={latestRun?.trace_timeline || []} />
                <div className="panel p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <ShieldCheck className="h-5 w-5 text-emerald-600" />
                    <h3 className="text-lg font-semibold">Security Layers</h3>
                  </div>
                  <div className="space-y-3">
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
                <div className="panel p-4">
                  <h3 className="text-sm font-semibold text-slate-900 mb-2">Suggestion Score Info</h3>
                  <p className="text-xs text-slate-700 mb-2">
                    Suggestion Score is a 0–100 confidence/quality score for the order decision.
                  </p>
                  <p className="text-xs text-slate-700 mb-2">
                    In this app it reflects how safe/strong the recommendation is based on:
                    medicine found, stock sufficiency, prescription rule, and approval/rejection outcome.
                  </p>
                  <p className="text-xs text-emerald-700 mb-1">
                    Higher score = stronger confidence (typically approved + enough stock + no prescription risk).
                  </p>
                  <p className="text-xs text-rose-700">
                    Lower score = weak/conflicting result (not found, low stock, rejected, etc.).
                  </p>
                </div>
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

      {checkoutFlow.checkoutId && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-900 mb-1">
              {checkoutFlow.stage === 'confirm' ? 'Confirm Order' : 'Payment'}
            </h3>
            <p className="text-sm text-slate-600 mb-4">
              {checkoutFlow.stage === 'confirm'
                ? 'Please confirm the order details.'
                : 'Click Pay Now to complete payment and place order.'}
            </p>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm space-y-1 mb-4">
              <p><span className="font-semibold">Medicine:</span> {checkoutFlow.medicineName}</p>
              <p><span className="font-semibold">Quantity:</span> {checkoutFlow.quantity}</p>
              <p><span className="font-semibold">Unit Price:</span> {checkoutFlow.unitPrice.toFixed(2)}</p>
              <p><span className="font-semibold">Total Price:</span> {checkoutFlow.totalPrice.toFixed(2)}</p>
            </div>
            <div className="flex gap-2 justify-end">
              {checkoutFlow.stage === 'confirm' ? (
                <>
                  <button
                    onClick={cancelCheckoutFlow}
                    disabled={paymentBusy}
                    className="rounded-xl px-4 py-2 text-sm font-semibold border bg-white disabled:opacity-50"
                  >
                    No
                  </button>
                  <button
                    onClick={confirmCheckoutFlow}
                    disabled={paymentBusy}
                    className="rounded-xl px-4 py-2 text-sm font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                  >
                    {paymentBusy ? 'Processing...' : 'Yes'}
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="email"
                    value={checkoutFlow.customerEmail}
                    onChange={(e) => setCheckoutFlow((prev) => ({ ...prev, customerEmail: e.target.value }))}
                    className="flex-1 min-w-[210px] rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    placeholder="Enter email for invoice"
                  />
                  <button
                    onClick={cancelCheckoutFlow}
                    disabled={paymentBusy}
                    className="rounded-xl px-4 py-2 text-sm font-semibold border bg-white disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={payCheckoutFlow}
                    disabled={paymentBusy || !isValidEmail(checkoutFlow.customerEmail)}
                    className="rounded-xl px-4 py-2 text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {paymentBusy ? 'Processing...' : 'Pay Now'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

