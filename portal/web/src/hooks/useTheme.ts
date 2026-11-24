import { useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'shrdc-theme'

function readInitialPreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {
    // Ignore storage errors
  }
  return 'system'
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readInitialPreference)

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = preference === 'dark' || (preference === 'system' && mql.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    try {
      window.localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      // Ignore storage errors
    }
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [preference])

  const cycleTheme = () => {
    setPreference((prev) => (prev === 'system' ? 'dark' : prev === 'dark' ? 'light' : 'system'))
  }

  return { preference, setPreference, cycleTheme }
}
