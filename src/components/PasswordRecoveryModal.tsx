import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  KeyRound,
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Mail,
  ArrowRight,
  ShieldCheck,
  X
} from 'lucide-react';

interface PasswordRecoveryModalProps {
  onSuccess?: () => void;
}

export const PasswordRecoveryModal: React.FC<PasswordRecoveryModalProps> = ({ onSuccess }) => {
  const {
    user,
    session,
    isPasswordRecovery,
    recoveryError,
    updatePassword,
    resetPassword,
    dismissPasswordRecovery
  } = useAuth();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [updateSuccess, setUpdateSuccess] = useState(false);

  // State for requesting a new link when current link is expired/invalid
  const [resendEmail, setResendEmail] = useState(user?.email || session?.user?.email || '');
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  useEffect(() => {
    const detectedEmail = user?.email || session?.user?.email || '';
    if (detectedEmail && !resendEmail) {
      setResendEmail(detectedEmail);
    }
  }, [user?.email, session?.user?.email, resendEmail]);

  const isVisible = isPasswordRecovery || Boolean(recoveryError) || updateSuccess;
  if (!isVisible) return null;

  const accountEmail = user?.email || session?.user?.email || '';
  const isExpiredOrInvalidMode = Boolean(recoveryError) && !isPasswordRecovery && !updateSuccess;

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!newPassword || newPassword.length < 6) {
      setFormError('La nueva contraseña debe tener al menos 6 caracteres.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setFormError('Las contraseñas introducidas no coinciden. Revisa ambos campos.');
      return;
    }

    setSubmitting(true);
    const res = await updatePassword(newPassword);
    setSubmitting(false);

    if (res.success) {
      setNewPassword('');
      setConfirmPassword('');
      setUpdateSuccess(true);
      if (onSuccess) {
        onSuccess();
      }
    } else {
      setFormError(res.error || 'No se pudo actualizar la contraseña. Inténtalo de nuevo.');
    }
  };

  const handleResendRecoverySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResendError(null);
    setResendMessage(null);

    if (!resendEmail.trim() || !resendEmail.includes('@')) {
      setResendError('Introduce un correo electrónico válido.');
      return;
    }

    setResending(true);
    const res = await resetPassword(resendEmail.trim());
    setResending(false);

    if (res.success) {
      setResendMessage(
        'Hemos enviado un nuevo enlace de recuperación a tu correo. Revisa tu bandeja de entrada o spam y abre el enlace más reciente.'
      );
    } else {
      setResendError(res.error || 'No se pudo enviar el correo de recuperación.');
    }
  };

  const handleClose = () => {
    setUpdateSuccess(false);
    setFormError(null);
    setResendError(null);
    setResendMessage(null);
    dismissPasswordRecovery();
  };

  return (
    <div
      className="fixed inset-0 z-[100] overflow-y-auto bg-slate-900/75 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-recovery-title"
    >
      <div className="relative bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Top Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-[#E5F3EF]/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#146C5B] text-white flex items-center justify-center shadow-xs">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h3 id="password-recovery-title" className="text-sm font-bold text-[#0E5145]">
                Restablecer contraseña
              </h3>
              <p className="text-[11px] text-slate-500">Seguridad de cuenta VecinoYa</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg transition-colors"
            title="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* STATE 1: PASSWORD UPDATED SUCCESSFULLY */}
          {updateSuccess && (
            <div className="text-center space-y-4 py-2">
              <div className="w-14 h-14 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <div className="space-y-1.5">
                <h4 className="text-lg font-bold text-slate-900">
                  ¡Contraseña actualizada con éxito!
                </h4>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Tu nueva contraseña se ha guardado de forma segura en Supabase Auth. Tu sesión ya está activa.
                </p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="w-full py-2.5 px-4 bg-[#146C5B] hover:bg-[#0E5145] text-white font-semibold text-sm rounded-xl shadow-xs transition-colors flex items-center justify-center gap-2"
              >
                <span>Continuar a VecinoYa</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* STATE 2: EXPIRED OR INVALID RECOVERY LINK */}
          {isExpiredOrInvalidMode && (
            <div className="space-y-5">
              <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 flex items-start gap-2.5">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold text-red-900">Enlace de recuperación caducado o no válido</p>
                  <p className="leading-relaxed">{recoveryError}</p>
                </div>
              </div>

              {resendMessage ? (
                <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-start gap-2.5">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">{resendMessage}</p>
                </div>
              ) : (
                <form onSubmit={handleResendRecoverySubmit} className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Solicitar un nuevo enlace de recuperación
                    </label>
                    <input
                      type="email"
                      value={resendEmail}
                      onChange={e => setResendEmail(e.target.value)}
                      placeholder="tu.correo@ejemplo.es"
                      className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-[#146C5B]/30 focus:border-[#146C5B] outline-hidden"
                      required
                    />
                  </div>

                  {resendError && (
                    <div className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                      <p>{resendError}</p>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={resending}
                    className="w-full py-2.5 bg-[#146C5B] hover:bg-[#0E5145] text-white font-semibold text-sm rounded-xl shadow-xs transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    <Mail className="w-4 h-4" />
                    <span>{resending ? 'Enviando enlace...' : 'Enviar nuevo enlace por correo'}</span>
                  </button>
                </form>
              )}

              <div className="pt-2 border-t border-slate-100 text-center">
                <button
                  type="button"
                  onClick={handleClose}
                  className="text-xs font-semibold text-slate-500 hover:text-slate-800"
                >
                  Volver al inicio de VecinoYa
                </button>
              </div>
            </div>
          )}

          {/* STATE 3: ACTIVE PASSWORD RECOVERY FORM */}
          {!updateSuccess && !isExpiredOrInvalidMode && (
            <div className="space-y-4">
              <div className="text-center space-y-1">
                <div className="w-12 h-12 bg-[#E5F3EF] text-[#0E5145] rounded-full flex items-center justify-center mx-auto mb-2">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <h4 className="text-base font-bold text-slate-900">
                  Introduce tu nueva contraseña
                </h4>
                <p className="text-xs text-slate-500">
                  {accountEmail ? (
                    <>
                      Restableciendo acceso para <span className="font-semibold text-slate-700">{accountEmail}</span>
                    </>
                  ) : (
                    'Elige una contraseña segura de al menos 6 caracteres para tu cuenta.'
                  )}
                </p>
              </div>

              {formError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <p>{formError}</p>
                </div>
              )}

              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nueva contraseña (mínimo 6 caracteres)
                  </label>
                  <div className="relative">
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      autoFocus
                      minLength={6}
                      className="w-full pl-3.5 pr-10 py-2.5 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-[#146C5B]/30 focus:border-[#146C5B] outline-hidden"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(prev => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      tabIndex={-1}
                    >
                      {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Confirmar nueva contraseña
                  </label>
                  <div className="relative">
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      minLength={6}
                      className="w-full pl-3.5 pr-10 py-2.5 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-[#146C5B]/30 focus:border-[#146C5B] outline-hidden"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(prev => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      tabIndex={-1}
                    >
                      {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {confirmPassword.length > 0 && newPassword !== confirmPassword && (
                    <p className="text-[11px] text-red-600 mt-1">
                      Las contraseñas aún no coinciden.
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-2.5 bg-[#146C5B] hover:bg-[#0E5145] text-white font-semibold text-sm rounded-xl shadow-xs transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <Lock className="w-4 h-4" />
                  <span>{submitting ? 'Guardando nueva contraseña...' : 'Guardar nueva contraseña'}</span>
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
