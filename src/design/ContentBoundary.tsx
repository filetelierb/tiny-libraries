import { Component, type ReactNode } from 'react';
import type { T } from '../i18n';
import { Button, Modal } from './components';

export class ContentBoundary extends Component<
  {
    children: ReactNode;
    t: T;
    title?: string;
    close?: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const { t, title = t.studyToolUnavailable, close } = this.props;
    const content = (
      <div className="content-recovery" role="alert">
        {!close && <h3>{title}</h3>}
        <p>{t.contentLoadRecovery}</p>
        <Button onClick={() => location.reload()}>{t.reloadApp}</Button>
      </div>
    );
    return close ? (
      <Modal title={title} close={close} closeLabel={t.close}>
        {content}
      </Modal>
    ) : (
      content
    );
  }
}
