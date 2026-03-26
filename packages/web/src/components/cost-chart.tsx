import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

interface CostEntry {
  month: string
  total: number
  byModel?: Record<string, number>
}

interface CostChartProps {
  data: CostEntry[]
}

/**
 * Monthly cost bar chart showing cost breakdown by model.
 */
export function CostChart({ data }: CostChartProps) {
  // Collect all model keys across data points
  const models = [...new Set(data.flatMap((d) => Object.keys(d.byModel ?? {})))]

  const COLORS = [
    'hsl(var(--primary))',
    'hsl(220, 70%, 60%)',
    'hsl(160, 60%, 50%)',
    'hsl(30, 80%, 55%)',
    'hsl(280, 60%, 60%)',
  ]

  if (models.length === 0) {
    // Flat total chart when no per-model breakdown
    return (
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
          <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, 'Cost']} />
          <Bar dataKey="total" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  const chartData = data.map((d) => ({
    month: d.month,
    ...d.byModel,
  }))

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
        <Tooltip formatter={(v: number) => `$${v.toFixed(4)}`} />
        <Legend />
        {models.map((model, i) => (
          <Bar
            key={model}
            dataKey={model}
            stackId="a"
            fill={COLORS[i % COLORS.length]}
            radius={i === models.length - 1 ? [4, 4, 0, 0] : undefined}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}
