// ODD-01: fixture mínimo de reloj virtual para casos temporales.
// Usa el mock nativo de node:test (apis:['Date']). node:test lo restaura solo
// al terminar el test, así que no contamina otros casos ni el proceso.
export function useVirtualClock(t, start = 1_700_000_000_000) {
  try {
    t.mock.timers.enable({ apis: ['Date'], now: start });
  } catch (err) {
    t.skip(`reloj virtual no soportado (${err.message})`);
    return null;
  }
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      t.mock.timers.setTime(now);
      return now;
    },
  };
}
