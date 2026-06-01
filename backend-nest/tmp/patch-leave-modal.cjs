// Patch script for frontend LeaveRequestModal.tsx
// Applies fixes #3, #7, #8 from the report
const fs = require('fs');
const path = require('path');

const target = 'C:\\Users\\Abd al Rhman ky\\Desktop\\Next\\factory\\components\\LeaveRequestModal.tsx';
const raw = fs.readFileSync(target, 'utf8');
const usesCRLF = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');

// 1) Imports: add useCallback + useQueryClient
const oldImportReact = 'import { useState, useEffect, useMemo, useRef } from "react";';
const newImportReact = 'import { useState, useEffect, useMemo, useRef, useCallback } from "react";';
if (!src.includes(oldImportReact)) {
  throw new Error('FAIL: react import line not found');
}
src = src.replace(oldImportReact, newImportReact);

const oldToastImport = 'import { toast } from "react-hot-toast";\nimport apiClient from "@/lib/api-client";';
const newToastImport =
  'import { toast } from "react-hot-toast";\n' +
  'import { useQueryClient } from "@tanstack/react-query";\n' +
  'import apiClient from "@/lib/api-client";';
if (!src.includes(oldToastImport)) {
  throw new Error('FAIL: toast import block not found');
}
src = src.replace(oldToastImport, newToastImport);

// 2) Inside component — add queryClient + handleClose right after useState block
const oldHooksBlock =
  'function LeaveRequestModalContent({ isOpen, onClose, employees }: Props) {\n' +
  '  const [isSubmitting, setIsSubmitting] = useState(false);\n' +
  '  const [form, setForm] = useState(buildDefaultForm);\n' +
  '  const [searchQuery, setSearchQuery] = useState("");\n' +
  '  const [isDropdownOpen, setIsDropdownOpen] = useState(false);\n' +
  '  const dropdownRef = useRef<HTMLDivElement>(null);';

const newHooksBlock =
  'function LeaveRequestModalContent({ isOpen, onClose, employees }: Props) {\n' +
  '  const [isSubmitting, setIsSubmitting] = useState(false);\n' +
  '  const [form, setForm] = useState(buildDefaultForm);\n' +
  '  const [searchQuery, setSearchQuery] = useState("");\n' +
  '  const [isDropdownOpen, setIsDropdownOpen] = useState(false);\n' +
  '  const dropdownRef = useRef<HTMLDivElement>(null);\n' +
  '  const queryClient = useQueryClient();\n' +
  '\n' +
  '  // إعادة تعيين النموذج بالكامل قبل الإغلاق — إصلاح #8\n' +
  '  const handleClose = useCallback(() => {\n' +
  '    setForm(buildDefaultForm());\n' +
  '    setSearchQuery("");\n' +
  '    setIsDropdownOpen(false);\n' +
  '    onClose();\n' +
  '  }, [onClose]);';

if (!src.includes(oldHooksBlock)) {
  throw new Error('FAIL: hooks declaration block not found');
}
src = src.replace(oldHooksBlock, newHooksBlock);

// 3) After successful save: invalidate leaves query + reset form + use handleClose
const oldSaveBlock =
  '      if (failed === 0) {\n' +
  '        toast.success(\n' +
  '          items.length === 1\n' +
  '            ? "تم حفظ طلب الإجازة بنجاح"\n' +
  '            : `تم حفظ ${succeeded} طلب إجازة بنجاح`\n' +
  '        );\n' +
  '        setForm(buildDefaultForm());\n' +
  '        onClose();\n' +
  '      } else {';

const newSaveBlock =
  '      if (failed === 0) {\n' +
  '        toast.success(\n' +
  '          items.length === 1\n' +
  '            ? "تم حفظ طلب الإجازة بنجاح"\n' +
  '            : `تم حفظ ${succeeded} طلب إجازة بنجاح`\n' +
  '        );\n' +
  '        // إصلاح #7: تأكيد بصري — إبطال كاش الإجازات حتى تُعاد قراءتها فوراً في أي قائمة مرتبطة\n' +
  '        await queryClient.invalidateQueries({ queryKey: ["leaves"], exact: false });\n' +
  '        setForm(buildDefaultForm());\n' +
  '        setSearchQuery("");\n' +
  '        setIsDropdownOpen(false);\n' +
  '        onClose();\n' +
  '      } else {';

if (!src.includes(oldSaveBlock)) {
  throw new Error('FAIL: success save block not found');
}
src = src.replace(oldSaveBlock, newSaveBlock);

// 4) Replace the two close-button onClick handlers (header X + footer Cancel) with handleClose
// We must only change the two that call onClose directly, not anything else.
const oldHeaderClose =
  '          <button\n' +
  '            onClick={onClose}\n' +
  '            className="text-slate-500 hover:text-rose-400 bg-[#263544] p-2.5 rounded-2xl border border-transparent hover:border-rose-400/30 transition-all active:scale-90"\n' +
  '          >';
const newHeaderClose =
  '          <button\n' +
  '            onClick={handleClose}\n' +
  '            className="text-slate-500 hover:text-rose-400 bg-[#263544] p-2.5 rounded-2xl border border-transparent hover:border-rose-400/30 transition-all active:scale-90"\n' +
  '          >';
if (!src.includes(oldHeaderClose)) {
  throw new Error('FAIL: header close button block not found');
}
src = src.replace(oldHeaderClose, newHeaderClose);

const oldFooterClose =
  '          <button\n' +
  '            type="button"\n' +
  '            onClick={onClose}\n' +
  '            disabled={isSubmitting}\n' +
  '            className="px-8 py-3.5 rounded-2xl font-bold text-slate-400 bg-[#263544] hover:text-white transition-all active:scale-95 disabled:opacity-60"\n' +
  '          >\n' +
  '            إلغاء';
const newFooterClose =
  '          <button\n' +
  '            type="button"\n' +
  '            onClick={handleClose}\n' +
  '            disabled={isSubmitting}\n' +
  '            className="px-8 py-3.5 rounded-2xl font-bold text-slate-400 bg-[#263544] hover:text-white transition-all active:scale-95 disabled:opacity-60"\n' +
  '          >\n' +
  '            إلغاء';
if (!src.includes(oldFooterClose)) {
  throw new Error('FAIL: footer cancel button block not found');
}
src = src.replace(oldFooterClose, newFooterClose);

fs.writeFileSync(target, src, 'utf8');
console.log('OK: LeaveRequestModal.tsx patched successfully');
