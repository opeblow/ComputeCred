import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from './primitives';

export function ConfigGate({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <EmptyState title={title}>
        <p>{children}</p>
        <Link className="btn outline" to="/app/settings">
          Open settings
        </Link>
      </EmptyState>
    </Card>
  );
}