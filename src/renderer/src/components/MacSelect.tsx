import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MacSelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface MacSelectGroup {
  label?: string
  options: MacSelectOption[]
}

interface MacSelectProps {
  value: string
  groups: MacSelectGroup[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  className?: string
}

export function MacSelect({
  value,
  groups,
  onChange,
  placeholder = '请选择',
  disabled = false,
  ariaLabel,
  className = ''
}: MacSelectProps): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220, maxHeight: 320 })
  const flatOptions = useMemo(() => groups.flatMap((group) => group.options), [groups])
  const selected = flatOptions.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const updatePosition = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      const roomBelow = window.innerHeight - rect.bottom - 14
      const menuHeight = Math.min(360, Math.max(120, flatOptions.length * 34 + groups.length * 24))
      const opensUp = roomBelow < Math.min(220, menuHeight) && rect.top > roomBelow
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 220) - 8)),
        top: opensUp ? Math.max(8, rect.top - menuHeight - 6) : rect.bottom + 6,
        width: Math.max(rect.width, 220),
        maxHeight: opensUp ? Math.max(120, rect.top - 20) : Math.max(120, roomBelow)
      })
    }
    const close = (event: PointerEvent): void => {
      if (anchorRef.current?.contains(event.target as Node)) return
      if ((event.target as Element)?.closest?.('.mac-select-menu')) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [flatOptions.length, groups.length, open])

  return (
    <div className={`mac-select ${open ? 'open' : ''} ${className}`}>
      <button
        ref={anchorRef}
        type="button"
        className="mac-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span title={selected?.label}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={13} />
      </button>
      {open && createPortal(
        <div
          className="mac-select-menu"
          role="listbox"
          style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
        >
          {groups.map((group, groupIndex) => (
            <section className="mac-select-group" key={`${group.label ?? 'group'}-${groupIndex}`}>
              {group.label && <header>{group.label}</header>}
              {group.options.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  className={option.value === value ? 'selected' : ''}
                  key={option.value}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value && <Check size={14} />}
                </button>
              ))}
            </section>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
