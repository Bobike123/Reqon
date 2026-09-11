import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConfigMissing } from './ConfigMissing.tsx'

describe('a build without its Supabase settings', () => {
  it('says what is missing and how to fix it, instead of a blank page', () => {
    render(<ConfigMissing names={['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']} />)
    expect(screen.getByRole('heading', { name: /can’t reach its database/ })).toBeInTheDocument()
    expect(screen.getAllByText('VITE_SUPABASE_URL').length).toBeGreaterThan(0)
    expect(screen.getByText(/Never use the secret or service_role key/)).toBeInTheDocument()
  })
})
