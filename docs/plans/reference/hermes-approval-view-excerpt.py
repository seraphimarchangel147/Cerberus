                try:
                    embed = msg.embeds[0] if msg.embeds else None
                    if embed:
                        embed.color = discord.Color.greyple()
                        embed.set_footer(text="⏱ Prompt expired — no action taken")
                    await msg.edit(embed=embed, view=self)
                except Exception:
                    pass  # message deleted or too old to edit

    class SlashConfirmView(discord.ui.View):
        """Three-button view for generic slash-command confirmations.

        Used by ``/reload-mcp`` and any future slash command routed through
        ``GatewayRunner._request_slash_confirm``.  Buttons map to the
        gateway's three choices:

          * "Approve Once"   → ``choice="once"``
          * "Always Approve" → ``choice="always"``
          * "Cancel"         → ``choice="cancel"``

        Clicking calls the module-level
        ``tools.slash_confirm.resolve(session_key, confirm_id, choice)``
        which runs the handler the runner stored for this ``session_key``.
        Only users in the adapter's allowlist can click.  Times out after
        5 minutes (matches the gateway primitive's timeout).
        """

        def __init__(
            self,
            session_key: str,
            confirm_id: str,
            allowed_user_ids: set,
            allowed_role_ids: Optional[set] = None,
        ):
            super().__init__(timeout=300)
            self.session_key = session_key
            self.confirm_id = confirm_id
            self.allowed_user_ids = allowed_user_ids
            self.allowed_role_ids = allowed_role_ids or set()
            self.resolved = False

        def _check_auth(self, interaction: discord.Interaction) -> bool:
            return _component_check_auth(
                interaction, self.allowed_user_ids, self.allowed_role_ids,
            )

        async def _resolve(
            self, interaction: discord.Interaction, choice: str,
            color: discord.Color, label: str,
        ):
            if self.resolved:
                await interaction.response.send_message(
                    "This prompt has already been resolved~", ephemeral=True,
                )
                return
            if not self._check_auth(interaction):
                await interaction.response.send_message(
                    "You're not authorized to answer this prompt~", ephemeral=True,
                )
                return

            self.resolved = True

            embed = interaction.message.embeds[0] if interaction.message.embeds else None
            if embed:
                embed.color = color
                embed.set_footer(text=f"{label} by {interaction.user.display_name}")

            for child in self.children:
                child.disabled = True

            await interaction.response.edit_message(embed=embed, view=self)

            # Resolve via the module-level primitive.  If the handler
            # returns a follow-up message, post it in the same channel.
            try:
                from tools import slash_confirm as _slash_confirm_mod
                result_text = await _slash_confirm_mod.resolve(
                    self.session_key, self.confirm_id, choice,
                )
                if result_text:
                    await interaction.followup.send(result_text)
                logger.info(
                    "Discord button resolved slash-confirm for session %s "
                    "(choice=%s, user=%s)",
                    self.session_key, choice, interaction.user.display_name,
                )
            except Exception as exc:
                logger.error("Discord slash-confirm resolve failed: %s", exc, exc_info=True)

        @discord.ui.button(label="Approve Once", style=discord.ButtonStyle.green)
        async def approve_once(
            self, interaction: discord.Interaction, button: discord.ui.Button,
        ):
            await self._resolve(interaction, "once", discord.Color.green(), "Approved once")

        @discord.ui.button(label="Always Approve", style=discord.ButtonStyle.blurple)
        async def approve_always(
            self, interaction: discord.Interaction, button: discord.ui.Button,
        ):
            await self._resolve(interaction, "always", discord.Color.purple(), "Always approved")

        @discord.ui.button(label="Cancel", style=discord.ButtonStyle.red)
        async def cancel(
            self, interaction: discord.Interaction, button: discord.ui.Button,
        ):
            await self._resolve(interaction, "cancel", discord.Color.greyple(), "Cancelled")

        async def on_timeout(self):
            self.resolved = True
            for child in self.children:
                child.disabled = True
            # Visually update the Discord message so buttons appear disabled.
            msg = getattr(self, '_message', None)
            if msg:
                try:
                    embed = msg.embeds[0] if msg.embeds else None
                    if embed:
                        embed.color = discord.Color.greyple()
                        embed.set_footer(text="⏱ Prompt expired — no action taken")
                    await msg.edit(embed=embed, view=self)
                except Exception:
                    pass

    class UpdatePromptView(discord.ui.View):
        """Interactive Yes/No buttons for ``hermes update`` prompts.
