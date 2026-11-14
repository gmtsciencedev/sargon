package mcpserver

import (
	"context"
	"fmt"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"
)

func registerPrompts(srv *mcpsrv.MCPServer, deps Deps) {
	registerSummarizePagePrompt(srv, deps)
	registerDraftReviewChecklistPrompt(srv, deps)
	registerSuggestTagsPrompt(srv, deps)
}

// promptArgs extracts the arguments map from a GetPromptRequest.
func promptArgs(req mcpgo.GetPromptRequest) map[string]string {
	if req.Params.Arguments == nil {
		return map[string]string{}
	}
	return req.Params.Arguments
}

// ── summarize_page ───────────────────────────────────────────────────────

func registerSummarizePagePrompt(srv *mcpsrv.MCPServer, deps Deps) {
	p := mcpgo.NewPrompt("summarize_page",
		mcpgo.WithPromptDescription(
			"Produce a short summary of a wiki page. Fetches the page content and builds a "+
				"ready-to-send message. Ask the LLM to return bullet points of the key ideas.",
		),
		mcpgo.WithArgument("path",
			mcpgo.RequiredArgument(),
			mcpgo.ArgumentDescription("Page path (leading slash optional)."),
		),
		mcpgo.WithArgument("max_bullets",
			mcpgo.ArgumentDescription("Maximum number of bullet points. Default 5."),
		),
	)
	srv.AddPrompt(p, func(ctx context.Context, req mcpgo.GetPromptRequest) (*mcpgo.GetPromptResult, error) {
		args := promptArgs(req)
		pagePath := canonicalPageArg(args["path"])
		if pagePath == "" {
			return nil, fmt.Errorf("path is required")
		}
		maxBullets := args["max_bullets"]
		if maxBullets == "" {
			maxBullets = "5"
		}

		if !deps.canView(ctx, pagePath) {
			return nil, fmt.Errorf("access denied")
		}
		if deps.Store == nil {
			return nil, fmt.Errorf("page store not available")
		}
		page, err := deps.Store.Get(pagePath)
		if err != nil {
			return nil, fmt.Errorf("page not found: %s", pagePath)
		}

		msg := fmt.Sprintf(
			"Summarize the following wiki page in at most %s bullet points. "+
				"Preserve key names, numbers, and invariants. Do not add information that "+
				"isn't in the source.\n\n--- begin page /%s ---\n%s\n--- end page ---",
			maxBullets, pagePath, page.Markdown,
		)

		return mcpgo.NewGetPromptResult(
			fmt.Sprintf("Summary of /%s", pagePath),
			[]mcpgo.PromptMessage{
				mcpgo.NewPromptMessage(mcpgo.RoleUser, mcpgo.NewTextContent(msg)),
			},
		), nil
	})
}

// ── draft_review_checklist ───────────────────────────────────────────────

func registerDraftReviewChecklistPrompt(srv *mcpsrv.MCPServer, deps Deps) {
	p := mcpgo.NewPrompt("draft_review_checklist",
		mcpgo.WithPromptDescription(
			"Generate a reviewer checklist for a page under reviewflow. Includes the page's "+
				"reviewflow roles and confirmation status so the reviewer can see what's pending.",
		),
		mcpgo.WithArgument("path",
			mcpgo.RequiredArgument(),
			mcpgo.ArgumentDescription("Page path (leading slash optional)."),
		),
	)
	srv.AddPrompt(p, func(ctx context.Context, req mcpgo.GetPromptRequest) (*mcpgo.GetPromptResult, error) {
		args := promptArgs(req)
		pagePath := canonicalPageArg(args["path"])
		if pagePath == "" {
			return nil, fmt.Errorf("path is required")
		}
		if !deps.canView(ctx, pagePath) {
			return nil, fmt.Errorf("access denied")
		}
		if deps.Store == nil {
			return nil, fmt.Errorf("page store not available")
		}
		page, err := deps.Store.Get(pagePath)
		if err != nil {
			return nil, fmt.Errorf("page not found: %s", pagePath)
		}

		rfBlock := ""
		if deps.Reviewflow != nil {
			if status, err := deps.Reviewflow.GetStatus(pagePath); err == nil && status != nil {
				rfBlock = fmt.Sprintf("\n\n--- reviewflow status ---\n%+v\n", status)
			}
		}

		msg := fmt.Sprintf(
			"You are preparing a review checklist for a wiki page. Produce a numbered list "+
				"of specific items a reviewer should verify before confirming their role. "+
				"Consider factual accuracy, internal consistency, missing cross-references, "+
				"and anything that might block downstream readers.%s\n\n--- page /%s ---\n%s\n--- end page ---",
			rfBlock, pagePath, page.Markdown,
		)

		return mcpgo.NewGetPromptResult(
			fmt.Sprintf("Review checklist for /%s", pagePath),
			[]mcpgo.PromptMessage{
				mcpgo.NewPromptMessage(mcpgo.RoleUser, mcpgo.NewTextContent(msg)),
			},
		), nil
	})
}

// ── suggest_tags ─────────────────────────────────────────────────────────

func registerSuggestTagsPrompt(srv *mcpsrv.MCPServer, deps Deps) {
	p := mcpgo.NewPrompt("suggest_tags",
		mcpgo.WithPromptDescription(
			"Propose topical tags for a page based on its current content and the tags already used elsewhere in the wiki.",
		),
		mcpgo.WithArgument("path",
			mcpgo.RequiredArgument(),
			mcpgo.ArgumentDescription("Page path (leading slash optional)."),
		),
	)
	srv.AddPrompt(p, func(ctx context.Context, req mcpgo.GetPromptRequest) (*mcpgo.GetPromptResult, error) {
		args := promptArgs(req)
		pagePath := canonicalPageArg(args["path"])
		if pagePath == "" {
			return nil, fmt.Errorf("path is required")
		}
		if !deps.canView(ctx, pagePath) {
			return nil, fmt.Errorf("access denied")
		}
		if deps.Store == nil {
			return nil, fmt.Errorf("page store not available")
		}
		page, err := deps.Store.Get(pagePath)
		if err != nil {
			return nil, fmt.Errorf("page not found: %s", pagePath)
		}

		existingTags := ""
		if deps.TagIndex != nil {
			tags := make([]string, 0, len(deps.TagIndex.TagToPages))
			for t := range deps.TagIndex.TagToPages {
				tags = append(tags, t)
			}
			if len(tags) > 0 {
				existingTags = "\n\nTags currently used elsewhere in the wiki (prefer reusing these): " +
					strings.Join(tags, ", ")
			}
		}

		msg := fmt.Sprintf(
			"Propose 3 to 7 short topical tags for the following wiki page. Use lowercase, "+
				"hyphen-separated words. Prefer tags that already exist in the wiki over "+
				"inventing new ones.%s\n\n--- page /%s ---\n%s\n--- end page ---",
			existingTags, pagePath, page.Markdown,
		)

		return mcpgo.NewGetPromptResult(
			fmt.Sprintf("Tag suggestions for /%s", pagePath),
			[]mcpgo.PromptMessage{
				mcpgo.NewPromptMessage(mcpgo.RoleUser, mcpgo.NewTextContent(msg)),
			},
		), nil
	})
}
