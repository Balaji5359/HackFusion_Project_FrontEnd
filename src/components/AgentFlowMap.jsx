const steps = [
  { id: 'User', x: '8%', y: '50%' },
  { id: 'Supervisor', x: '30%', y: '50%' },
  { id: 'Intent', x: '52%', y: '22%' },
  { id: 'Safety', x: '52%', y: '50%' },
  { id: 'Action', x: '52%', y: '78%' },
  { id: 'DynamoDB', x: '76%', y: '78%' },
]

const baseEdges = [
  ['User', 'Supervisor'],
  ['Supervisor', 'Intent'],
  ['Intent', 'Supervisor'],
  ['Supervisor', 'Safety'],
  ['Safety', 'Supervisor'],
]

const approvedEdges = [
  ['Supervisor', 'Action'],
  ['Action', 'DynamoDB'],
  ['Action', 'Supervisor'],
]

function findNode(id) {
  return steps.find((n) => n.id === id)
}

export default function AgentFlowMap({ approved = true }) {
  const edges = approved ? [...baseEdges, ...approvedEdges] : baseEdges

  return (
    <div className="panel p-4">
      <h3 className="text-lg font-semibold text-slate-900 mb-2">Agent Communication Trace Map</h3>
      <div className="relative h-80 w-full rounded-xl bg-slate-50 border border-slate-200 overflow-hidden">
        {edges.map(([src, dst], idx) => {
          const a = findNode(src)
          const b = findNode(dst)
          return (
            <svg key={`${src}-${dst}-${idx}`} className="absolute inset-0 w-full h-full" aria-hidden>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#0f172a"
                strokeWidth="2"
                strokeDasharray="5 5"
              />
            </svg>
          )
        })}

        {steps.map((node) => (
          <div
            key={node.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 px-3 py-2 rounded-full bg-sky-100 border-2 border-slate-900 text-slate-900 text-sm font-semibold shadow-sm"
            style={{ left: node.x, top: node.y }}
          >
            {node.id}
          </div>
        ))}
      </div>
    </div>
  )
}
