import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportJsonToolbar } from './export-json-toolbar.js';

const copyJson = vi.fn(async () => true);
const downloadJson = vi.fn();

vi.mock('./export-json.js', () => ({
  copyJson: (value: unknown) => copyJson(value),
  downloadJson: (filename: string, value: unknown) => downloadJson(filename, value),
}));

describe('ExportJsonToolbar', () => {
  afterEach(() => {
    copyJson.mockClear();
    downloadJson.mockClear();
  });

  it('calls copyJson with the value when "Copy JSON" is clicked', async () => {
    const value = { id: 'e1', batch: [] };
    render(<ExportJsonToolbar value={value} filename="telescope-entry-e1.json" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    expect(copyJson).toHaveBeenCalledWith(value);
    // success flips the label to "Copied"
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('calls downloadJson with the filename and value when "Download JSON" is clicked', () => {
    const value = { id: 'e1', batch: [] };
    render(<ExportJsonToolbar value={value} filename="telescope-entry-e1.json" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }));
    expect(downloadJson).toHaveBeenCalledWith('telescope-entry-e1.json', value);
  });
});
