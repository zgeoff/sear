import type { Notification } from '../types';

export type OpenURL = (url: string) => void;

export type CopyToClipboard = (text: string) => void;

export type NotificationsPaneProps = {
  notifications: Notification[];
  focused: boolean;
  selectedIndex: number;
};
