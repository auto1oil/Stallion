'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

export default function AccountPage() {
  const router = useRouter();
  const supabase = createClient();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleChange(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setMessage('');

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      setError(updateError.message);
      setSaving(false);
      return;
    }

    // Clear the must_change_password flag
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from('profiles')
        .update({ must_change_password: false })
        .eq('id', user.id);
    }

    setMessage('Password changed successfully. Redirecting…');
    setNewPassword('');
    setConfirmPassword('');
    setSaving(false);
    setTimeout(() => router.push('/'), 1500);
  }

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', padding: 20 }}>
      <button
        onClick={() => router.back()}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#6b7280',
          fontSize: 14,
          cursor: 'pointer',
          marginBottom: 16,
        }}
      >
        ← Back
      </button>

      <div
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 24,
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>
          Set your password
        </h1>
        <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 20 }}>
          Welcome! Choose a password before continuing. Must be at least 8 characters.
        </p>

        <form onSubmit={handleChange}>
          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 500,
                marginBottom: 5,
              }}
            >
              New password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              autoComplete="new-password"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontSize: 14,
              }}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 500,
                marginBottom: 5,
              }}
            >
              Confirm new password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontSize: 14,
              }}
            />
          </div>

          {error && (
            <p style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>
              {error}
            </p>
          )}
          {message && (
            <p style={{ color: '#059669', fontSize: 13, marginBottom: 12 }}>
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            style={{
              width: '100%',
              padding: 10,
              background: '#854F0B',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 500,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </div>
    </div>
  );
}
