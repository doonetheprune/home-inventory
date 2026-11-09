/**
 * The household's unit list in the app: Larder's own units and the words the household added
 * (Settings → Units). The app says amounts with the core's own helpers (format.ts), so it reads
 * the list once and keeps it here; until it has loaded, the built-in list stands in.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { builtInUnits, unitList, type Units } from '@larder/core';
import { api } from './api';
import { setUnitList } from './format';

/** The unit list, kept up to date (adding a unit in Settings refreshes it). */
export function useUnits(): Units {
  const { data } = useQuery({ queryKey: ['units'], queryFn: api.units.list, staleTime: 5 * 60_000 });
  const units = useMemo(() => (data ? unitList(data.filter((u) => !u.builtIn).map(({ one, many }) => ({ one, many }))) : builtInUnits), [data]);
  // format.ts says amounts outside components too, so it keeps the list as it last loaded.
  setUnitList(units);
  return units;
}
