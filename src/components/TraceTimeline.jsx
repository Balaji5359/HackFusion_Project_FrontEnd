export default function TraceTimeline({ events }) {
  return (
    <div className="panel p-4">
      <h3 className="text-lg font-semibold mb-3">Trace Timeline</h3>
      <div className="fast-scroll space-y-3 max-h-[32rem] overflow-auto pr-1">
        {events.map((item) => (
          <div key={item.step} className="rounded-xl border border-slate-200 p-3 bg-slate-50">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs uppercase tracking-wide text-slate-500">Step {item.step}</p>
              <p className="text-xs text-slate-500">{item.stage}</p>
            </div>
            <p className="text-sm text-slate-800">{item.summary}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
