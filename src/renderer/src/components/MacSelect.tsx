import { Check, ChevronDown } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  menuMinWidth?: number
}

export function MacSelect({
  value,
  groups,
  onChange,
  placeholder = '请选择',
  disabled = false,
  ariaLabel,
  className = '',
  menuMinWidth = 0
}: MacSelectProps): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 340, maxHeight: 300 })
  const flatOptions = useMemo(() => groups.flatMap((group) => group.options), [groups])
  const selected = flatOptions.find((option) => option.value === value)

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      const roomBelow = window.innerHeight - rect.bottom - 8
      const roomAbove = rect.top - 8
      const menuHeight = Math.min(300, Math.max(86, flatOptions.length * 28 + groups.filter((group) => group.label).length * 22 + 10))
      const opensUp = roomBelow < Math.min(220, menuHeight) && rect.top > roomBelow
      const maxHeight = Math.min(300, opensUp ? roomAbove : roomBelow)
      const menuWidth = Math.min(
        Math.max(rect.width, menuMinWidth),
        window.innerWidth - 16
      )
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
        top: opensUp ? Math.max(8, rect.top - Math.min(menuHeight, maxHeight) - 2) : rect.bottom + 2,
        width: menuWidth,
        maxHeight: Math.max(86, maxHeight)
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
  }, [flatOptions.length, groups.length, menuMinWidth, open])

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
