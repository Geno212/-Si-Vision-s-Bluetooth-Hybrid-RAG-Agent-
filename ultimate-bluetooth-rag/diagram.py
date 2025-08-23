# --- CrewAI Flow Diagram (clean, professional, small arrows) ---
# Run this as-is. It saves:
#   ./crew_flow_refined.png
#   ./crew_flow_refined.pdf
# In Jupyter/Colab it will also show clickable download links.

import os
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np

# ----------------------- Config -----------------------
OUT_PNG = "crew_flow_refined.png"
OUT_PDF = "crew_flow_refined.pdf"

BOX_W, BOX_H = 6.2, 2.1         # box sizes
TITLE_FS, SUB_FS = 14, 11        # font sizes
ARROW_HEAD = dict(tail=0.4, head_w=6, head_l=8, lw=1.8)  # small, neat arrows
FONT = "DejaVu Sans"             # fallback font that ships with matplotlib

# ------------------- Drawing helpers ------------------
def add_box(ax, xy, title, subtitle="",
            box_size=(BOX_W, BOX_H), face="#FFFFFF", edge="#222222",
            title_fs=TITLE_FS, sub_fs=SUB_FS):
    x, y = xy
    w, h = box_size
    box = FancyBboxPatch(
        (x - w / 2, y - h / 2), w, h,
        boxstyle="round,pad=0.08,rounding_size=0.18",
        linewidth=1.8, facecolor=face, edgecolor=edge, zorder=2
    )
    ax.add_patch(box)
    ax.text(x, y + 0.26 * h, title, ha="center", va="center",
            fontsize=title_fs, fontname=FONT, weight="bold")
    if subtitle:
        ax.text(x, y - 0.12 * h, subtitle, ha="center", va="center",
                fontsize=sub_fs, fontname=FONT, color="#333333", wrap=True)
    return np.array([x, y])

def add_arrow(ax, p1, p2, label="", style="solid", both=False):
    # Smaller, professional arrow
    arrowprops = dict(
        arrowstyle=f"Simple,tail_width={ARROW_HEAD['tail']},head_width={ARROW_HEAD['head_w']},head_length={ARROW_HEAD['head_l']}",
        shrinkA=18, shrinkB=18, mutation_scale=10, linewidth=ARROW_HEAD['lw'], color="#222222"
    )
    if style == "dashed":
        arrowprops["linestyle"] = "--"
    elif style == "dotted":
        arrowprops["linestyle"] = ":"

    a1 = FancyArrowPatch(p1, p2, connectionstyle="arc3", **arrowprops, zorder=1)
    ax.add_patch(a1)
    if both:
        a2 = FancyArrowPatch(p2, p1, connectionstyle="arc3", **arrowprops, zorder=1)
        ax.add_patch(a2)

    # Label centered with a white backing for legibility
    mid = (np.array(p1) + np.array(p2)) / 2.0
    ax.text(mid[0], mid[1] + 0.5, label, ha="center", va="center", fontsize=11,
            fontname=FONT, bbox=dict(boxstyle="round,pad=0.18",
            facecolor="white", edgecolor="none", alpha=0.95))

# ------------------- Build the figure ------------------
fig, ax = plt.subplots(figsize=(15, 10))

# Node positions (top → bottom layout)
C = add_box(ax, (0, 13.5), "Agent Coordinator",
            "(Plans & orchestrates tasks)")

R = add_box(ax, (-11, 9.4), "Knowledge Retrieval",
            "(Finds sources • expands queries • ranks & cites)")

S = add_box(ax, (0, 9.4), "Synthesis & Analysis",
            "(Combines evidence • derives steps • resolves conflicts)")

Q = add_box(ax, (11, 9.4), "Quality Validation",
            "(Checks accuracy • completeness • standards compliance)")

B = add_box(ax, (-4.5, 4.8), "Bluetooth Specialist",
            "(Protocol expertise • compatibility • performance tuning)")

D = add_box(ax, (4.5, 4.8), "Device Interaction",
            "(Device registry • context • troubleshooting)")

# Edges (small arrows, clear labels)
add_arrow(ax, C, R, "delegate: retrieval")
add_arrow(ax, C, S, "delegate: synthesis")
add_arrow(ax, C, Q, "delegate: QA")

add_arrow(ax, R, S, "share: passages & gaps", both=True)
add_arrow(ax, S, Q, "review: logic & citations", both=True)

add_arrow(ax, S, B, "escalate: protocol deep-dive")
add_arrow(ax, S, D, "request: device context & logs")
add_arrow(ax, B, D, "interop checks & fixes", both=True)

add_arrow(ax, Q, R, "feedback: refine search / cites", style="dotted")

# Canvas appearance
ax.set_xlim(-15, 15)
ax.set_ylim(3.2, 14.8)
ax.axis("off")
fig.tight_layout()

# ------------------- Save files ------------------------
fig.savefig(OUT_PNG, dpi=300, bbox_inches="tight")
fig.savefig(OUT_PDF, dpi=300, bbox_inches="tight")
print(f"Saved: {os.path.abspath(OUT_PNG)}")
print(f"Saved: {os.path.abspath(OUT_PDF)}")

# If running in Jupyter/Colab, show clickable download links:
try:
    from IPython.display import FileLink, display
    display(FileLink(OUT_PNG))
    display(FileLink(OUT_PDF))
except Exception:
    pass
