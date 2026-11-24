import { useState, type FormEvent } from 'react'
import { Cpu, Eye, EyeOff, Lock, Moon, Sun, Monitor, ArrowRight } from 'lucide-react'
import type { ThemePreference } from '../hooks/useTheme'

interface LoginViewProps {
  initialError?: string
  theme: ThemePreference
  onCycleTheme: () => void
  onAuthenticated: () => void
}

export function LoginView({
  initialError = '',
  theme,
  onCycleTheme,
  onAuthenticated,
}: LoginViewProps) {
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(initialError)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ token: token.trim() }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Invalid passphrase.')
      }
      onAuthenticated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between px-5 py-3.5 border-b border-line bg-surface">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand border border-brand/25">
            <Cpu className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight text-sm">SHRDC · OpenPLC v4 + OIP</span>
        </div>
        <button
          type="button"
          onClick={onCycleTheme}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-ink hover:bg-subtle transition-colors cursor-pointer"
          aria-label={`Theme: ${theme}. Switch theme`}
        >
          <ThemeIcon className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="capitalize">{theme}</span>
        </button>
      </header>

      <main className="flex-1 grid place-items-center p-6">
        <div className="w-full max-w-md rounded-xl border border-line bg-surface p-7 shadow-sm">
          <div className="flex items-center gap-2.5 mb-2">
            <Lock className="h-4 w-4 text-brand" aria-hidden="true" />
            <h1 className="text-lg font-semibold tracking-tight">Demo Console Sign-In</h1>
          </div>
          <p className="text-sm text-muted mb-5">
            Enter your evaluation passphrase or open your shareable magic link.
          </p>

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-sm text-danger"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="access-token" className="block text-sm font-medium mb-1.5">
                Passphrase
              </label>
              <div className="flex gap-2">
                <input
                  id="access-token"
                  name="token"
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="current-password"
                  aria-invalid={error ? 'true' : undefined}
                  required
                  placeholder="Enter demo passphrase"
                  className="flex-1 min-h-[44px] rounded-lg border border-line bg-canvas px-3 py-2 text-base font-mono placeholder:text-muted/70"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  aria-pressed={showToken}
                  aria-label={showToken ? 'Hide passphrase' : 'Show passphrase'}
                  className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg border border-line bg-subtle text-muted hover:text-ink transition-colors cursor-pointer"
                >
                  {showToken ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 min-h-[44px] rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60 transition cursor-pointer"
            >
              <span>{submitting ? 'Verifying…' : 'Unlock Console'}</span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}
