import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return year && month && day ? new Date(year, month - 1, day) : new Date()
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function MacDatePicker({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = useMemo(() => parseDate(value), [value])
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1))
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const leading = (new Date(year, monthIndex, 1).getDay() + 6) % 7
  const count = new Date(year, monthIndex + 1, 0).getDate()

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  return (
    <div className="mac-date-picker" ref={rootRef}>
      <button type="button" className="mac-date-trigger" aria-label={ariaLabel} onClick={() => setOpen((current) => !current)}>
        <span>{value.replaceAll('-', '/')}</span><CalendarDays size={13} />
      </button>
      {open && (
        <div className="mac-calendar-popover">
          <header>
            <button type="button" onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}><ChevronLeft size={14} /></button>
            <strong>{year}年{monthIndex + 1}月</strong>
            <button type="button" onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}><ChevronRight size={14} /></button>
          </header>
          <div className="mac-calendar-weekdays">{['一','二','三','四','五','六','日'].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="mac-calendar-days">
            {Array.from({ length: leading }, (_, index) => <i key={`blank-${index}`} />)}
            {Array.from({ length: count }, (_, index) => {
              const date = new Date(year, monthIndex, index + 1)
              const key = dateKey(date)
              return <button type="button" className={`${key === value ? 'selected' : ''} ${key === dateKey(new Date()) ? 'today' : ''}`} key={key} onClick={() => { onChange(key); setOpen(false) }}>{index + 1}</button>
            })}
          </div>
          <footer><button type="button" onClick={() => { const today = new Date(); onChange(dateKey(today)); setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setOpen(false) }}>今天</button></footer>
        </div>
      )}
    </div>
  )
}
