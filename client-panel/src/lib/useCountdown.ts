import { useEffect, useState } from 'react';
import { timeRemaining } from './format';

/** Ticks every second and returns the live countdown to an ISO expiry. */
export function useCountdown(expiresAt: string | undefined) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return timeRemaining(expiresAt);
}
