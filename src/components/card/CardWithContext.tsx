import { memo } from "react";
import { Card } from "./CardView";
import { useCardContextMenu } from "@/hooks/useCardContextMenu";
import type { CardContextProps } from "./cardTypes";

export const CardWithContext = memo(function CardWithContext(props: CardContextProps) {
  const menuItems = useCardContextMenu(props);
  return <Card {...props} menuItems={menuItems} />;
});
