import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const Now = createContext<number | null>(null);

/** Keep one interval and update only the parts of the view that read the time. */
export function Clock({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  return <Now.Provider value={now}>{children}</Now.Provider>;
}

export function ClockValue({ children }: { children: (now: number) => ReactNode }) {
  return <>{children(useContext(Now) ?? Date.now())}</>;
}
