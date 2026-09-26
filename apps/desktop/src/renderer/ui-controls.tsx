import { TextInput, type TextInputProps } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import type { ComponentProps, CSSProperties } from "react";

interface FieldBase {
  readonly label: string;
  readonly className?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly name?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
  readonly "aria-describedby"?: string | undefined;
}

export type TextFieldProps = Omit<ComponentProps<"input">, "value" | "size" | "children"> &
  FieldBase & {
    readonly value: string;
    readonly onValueChange?: ((value: string) => void) | undefined;
  };

export function TextField({
  label,
  disabled,
  required,
  readOnly,
  name,
  autoFocus,
  className = "",
  onChange,
  onValueChange,
  type = "text",
  ...props
}: TextFieldProps) {
  return (
    <TextInput
      {...props}
      status={
        props["aria-invalid"] === true || props["aria-invalid"] === "true"
          ? { type: "error" }
          : undefined
      }
      label={label}
      isLabelHidden
      // TextInput forwards type to its native input; keep URL/search validation.
      type={type as TextInputProps["type"]}
      size="lg"
      htmlName={name}
      isDisabled={disabled ?? false}
      isRequired={required ?? false}
      isReadOnly={readOnly ?? false}
      hasAutoFocus={autoFocus ?? false}
      className={`pico-text-field ${className}`.trim()}
      onChange={(value, event) => {
        onChange?.(event);
        onValueChange?.(value);
      }}
    />
  );
}

export type TextAreaFieldProps = Omit<ComponentProps<"textarea">, "value" | "children"> &
  FieldBase & {
    readonly value: string;
    readonly onValueChange?: ((value: string) => void) | undefined;
  };

export function TextAreaField({
  label,
  disabled,
  required,
  readOnly,
  name,
  autoFocus,
  className = "",
  onChange,
  onValueChange,
  ...props
}: TextAreaFieldProps) {
  return (
    <TextArea
      {...props}
      status={
        props["aria-invalid"] === true || props["aria-invalid"] === "true"
          ? { type: "error" }
          : undefined
      }
      label={label}
      isLabelHidden
      htmlName={name}
      isDisabled={disabled ?? false}
      isRequired={required ?? false}
      isReadOnly={readOnly ?? false}
      hasAutoFocus={autoFocus ?? false}
      className={`pico-textarea-field ${className}`.trim()}
      onChange={(value, event) => {
        onChange?.(event);
        onValueChange?.(value);
      }}
    />
  );
}

export interface SelectFieldProps extends FieldBase {
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly disabled?: boolean;
  }[];
  readonly onValueChange: (value: string) => void;
  readonly title?: string | undefined;
}

export function SelectField({
  label,
  disabled,
  required,
  name,
  className = "",
  options,
  onValueChange,
  ...props
}: SelectFieldProps) {
  return (
    <Selector
      {...props}
      status={
        props["aria-invalid"] === true || props["aria-invalid"] === "true"
          ? { type: "error" }
          : undefined
      }
      label={label}
      isLabelHidden
      size="lg"
      htmlName={name}
      isDisabled={disabled ?? false}
      isRequired={required ?? false}
      options={[...options]}
      onChange={onValueChange}
      className={`pico-select-field ${className}`.trim()}
    />
  );
}

interface BooleanFieldProps extends FieldBase {
  readonly labelHidden?: boolean;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}

export function SwitchField({
  label,
  labelHidden = true,
  checked,
  disabled,
  required,
  name,
  onCheckedChange,
  className = "",
  ...props
}: BooleanFieldProps) {
  return (
    <Switch
      {...props}
      status={
        props["aria-invalid"] === true || props["aria-invalid"] === "true"
          ? { type: "error" }
          : undefined
      }
      label={label}
      isLabelHidden={labelHidden}
      value={checked}
      htmlName={name}
      isDisabled={disabled ?? false}
      isRequired={required ?? false}
      onChange={onCheckedChange}
      className={`pico-switch-field ${className}`.trim()}
    />
  );
}

export function CheckboxField({
  label,
  labelHidden = true,
  checked,
  disabled,
  required,
  name,
  onCheckedChange,
  className = "",
  ...props
}: BooleanFieldProps) {
  return (
    <CheckboxInput
      {...props}
      status={
        props["aria-invalid"] === true || props["aria-invalid"] === "true"
          ? { type: "error" }
          : undefined
      }
      label={label}
      isLabelHidden={labelHidden}
      value={checked}
      htmlName={name}
      isDisabled={disabled ?? false}
      isRequired={required ?? false}
      onChange={onCheckedChange}
      className={`pico-checkbox-field ${className}`.trim()}
    />
  );
}
