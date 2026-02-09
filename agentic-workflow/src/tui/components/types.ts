export type OpenURL = (url: string) => void;

export type CopyToClipboard = (text: string) => void;

export type SelectIndex = (index: number) => void;

export type NotificationsKeyState = {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
};
