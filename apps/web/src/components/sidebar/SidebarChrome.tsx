import {
  ArrowLeftIcon,
  BriefcaseIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  GitPullRequestIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { type AppMode, useAppMode, useIsWorkMode, useWorkModeStore } from "../../workModeStore";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden rounded-full px-1.5 text-muted-foreground @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

const APP_MODE_OPTIONS = [
  { mode: "code", label: "Code", description: "Projects, terminals, and Git", icon: CodeIcon },
  { mode: "work", label: "Work", description: "Folders and chats", icon: BriefcaseIcon },
] as const satisfies ReadonlyArray<{
  mode: AppMode;
  label: string;
  description: string;
  icon: typeof CodeIcon;
}>;

/** "T3 Code" / "T3 Work": the brand doubles as the switch between the two modes. */
function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  const mode = useAppMode();
  const setMode = useWorkModeStore((state) => state.setMode);
  const current = APP_MODE_OPTIONS.find((option) => option.mode === mode) ?? APP_MODE_OPTIONS[0];
  return (
    <Menu>
      <MenuTrigger
        aria-label={`T3 ${current.label}. Switch mode`}
        data-app-mode={mode}
        className={cn(
          "group/brand relative z-10 ml-[calc(var(--workspace-titlebar-content-left)-0.25rem)] hidden h-7 w-fit min-w-0 shrink-0 cursor-pointer items-center gap-1 overflow-hidden rounded-md px-1 outline-hidden ring-ring [-webkit-app-region:no-drag] hover:bg-sidebar-accent/70 focus-visible:ring-2 data-[popup-open]:bg-sidebar-accent/70 md:flex",
          onBackdrop ? "text-white hover:bg-white/15" : "text-foreground",
        )}
      >
        {/* Center the visible capitals, without the font's ascender/descender space. */}
        <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
          <span
            className={cn(
              "truncate [text-box:trim-both_cap_alphabetic]",
              onBackdrop ? "text-white/70" : "text-muted-foreground",
            )}
          >
            {current.label}
          </span>
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 opacity-50 group-hover/brand:opacity-90",
            onBackdrop ? "text-white/70" : "text-muted-foreground",
          )}
        />
      </MenuTrigger>
      <MenuPopup align="start" className="w-60">
        {APP_MODE_OPTIONS.map((option) => {
          const Icon = option.icon;
          return (
            <MenuItem key={option.mode} onClick={() => setMode(option.mode)}>
              <Icon className="size-4" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">T3 {option.label}</span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </span>
              {option.mode === mode ? <CheckIcon className="size-4 shrink-0" /> : null}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/usage"
            ? "usage"
            : location.pathname === "/pull-requests"
              ? "pull-requests"
              : null,
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const isWorkMode = useIsWorkMode();
  const pullRequestsSupported =
    !isWorkMode &&
    environments.some(
      (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
    );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  return (
    <SidebarMenu className="flex-row items-center">
      {currentFooterPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<GitPullRequestIcon />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="px-[var(--sidebar-content-inset)] py-1">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
