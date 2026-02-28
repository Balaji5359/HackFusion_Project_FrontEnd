import { Activity, CheckCircle2, Clock3, ShieldCheck } from 'lucide-react'

const icons = {
  success: CheckCircle2,
  latency: Clock3,
  score: ShieldCheck,
  traces: Activity,
}

export default function MetricCard({ title, value, tone = 'success' }) {
  const Icon = icons[tone] || Activity
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-slate-600">{title}</p>
        <Icon className="h-4 w-4 text-sky-600" />
      </div>
      <p className="text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
    </div>
  )
}
