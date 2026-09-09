import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ethers } from 'ethers';
import { useConfig, useProvider } from './useConfig';
import { createVault, loadSnapshot, type FacilitySnapshot, type VaultCallable } from '../lib/vault';
import {
  fetchSettlements,
  fetchProofStatus,
  fetchActivity,
  type SettlementRecord,
  type SettlementsPage,
  type ProofStatusCount,
} from '../lib/api';

export function useVault(): VaultCallable | null {
  const { provider } = useProvider();
  const { config } = useConfig();
  return useMemo(() => {
    if (!provider || !ethers.isAddress(config.vaultAddress)) return null;
    return createVault(provider, config.vaultAddress);
  }, [provider, config.vaultAddress]);
}

export interface FacilityQuery {
  snapshot: FacilitySnapshot | undefined;
  isLoading: boolean;
  isError: boolean;
  error: string | null;
  isEnabled: boolean;
}

export function useFacility(): FacilityQuery {
  const { config } = useConfig();
  const vault = useVault();
  const enabled = !!vault && ethers.isAddress(config.operatorAddress);

  const { data, isLoading, isError, error, isPending } = useQuery<FacilitySnapshot>({
    queryKey: ['facility', config.vaultAddress, config.operatorAddress, config.rpcUrl],
    queryFn: async () => {
      if (!vault) throw new Error('vault not configured');
      return loadSnapshot(vault, config.operatorAddress);
    },
    enabled,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });

  return {
    snapshot: data,
    isLoading: enabled && isPending,
    isError,
    isEnabled: enabled,
    error: isError && error ? messageOf(error) : null,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const API_POLL_MS = 15_000;

export function useSettlements(opts: { status?: string; cursor?: number; limit?: number }) {
  const { config } = useConfig();
  const enabled = ethers.isAddress(config.operatorAddress);
  return useQuery<SettlementsPage>({
    queryKey: ['settlements', config.operatorAddress, opts.status, opts.cursor],
    queryFn: () =>
      fetchSettlements({
        operator: config.operatorAddress,
        status: opts.status,
        cursor: opts.cursor,
        limit: opts.limit ?? 50,
      }),
    enabled,
    refetchInterval: API_POLL_MS,
    placeholderData: keepPreviousData,
  });
}

export function useProofStatus() {
  const { config } = useConfig();
  const enabled = ethers.isAddress(config.operatorAddress);
  return useQuery<ProofStatusCount[]>({
    queryKey: ['proof-status', config.operatorAddress],
    queryFn: () => fetchProofStatus(config.operatorAddress),
    enabled,
    refetchInterval: API_POLL_MS,
  });
}

export function useRecentActivity(limit = 30) {
  const { config } = useConfig();
  const enabled = ethers.isAddress(config.operatorAddress);
  return useQuery<SettlementRecord[]>({
    queryKey: ['activity', config.operatorAddress, limit],
    queryFn: () => fetchActivity(config.operatorAddress, limit),
    enabled,
    refetchInterval: API_POLL_MS,
  });
}

/** On-chain SettlementVerified recent events (authoritative evidence, API-independent). */
export function useVerifiedEvents(limit = 25) {
  const { provider } = useProvider();
  const { config } = useConfig();
  const vault = useVault();
  const operator = config.operatorAddress.toLowerCase();

  return useQuery<ethers.EventLog[]>({
    queryKey: ['verified-events', config.operatorAddress, config.vaultAddress],
    queryFn: async () => {
      if (!vault || !provider) throw new Error('vault not configured');
      const to = await provider.getBlockNumber();
      const from = Math.max(to - 25000, 0);
      const events = await vault.queryFilter('SettlementVerified', from, to);
      return events.slice(-limit);
    },
    enabled: !!vault && !!provider && ethers.isAddress(config.operatorAddress),
    refetchInterval: 60_000,
    select: (events) =>
      events.filter((e) => {
        const args = e.args as unknown as [string, string, string, bigint, bigint] | undefined;
        return args?.[0]?.toLowerCase() === operator;
      }),
  });
}