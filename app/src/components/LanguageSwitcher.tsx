import { LOCALES, useI18n, type Locale } from "../i18n";

type Props = {
  className?: string;
};

/** Language picker; the choice is stored by the i18n provider. */
export function LanguageSwitcher({ className }: Props) {
  const { locale, setLocale, t } = useI18n();

  return (
    <label className={className ? `lang-switcher ${className}` : "lang-switcher"}>
      <span className="sr-only">{t("language.label")}</span>
      <select
        value={locale}
        aria-label={t("language.label")}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {LOCALES.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
    </label>
  );
}
