/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <deque>
#include <functional>
#include <map>
#include <set>
#include <vector>

#include <eda_item.h>
#include <gal/color4d.h>
#include <layer_ids.h>
#include <math/box2.h>
#include <math/vector2d.h>
#include <wx/string.h>

namespace KIGFX
{
class GAL;
class PAINTER;
class VIEW;
}


/// A live in-flight segment from a peer (a track being routed, a wire being drawn).
struct REMOTE_GHOST_SEG
{
    VECTOR2I a;
    VECTOR2I b;
    int      width = 0;

    /// The layer whose colour to draw in, for an existing line a peer is reshaping (it
    /// stands in for the hidden original, so it should look like one); -1 draws in the
    /// peer colour, for a segment that does not exist yet.
    int      layer = -1;
};


/// A local item drawn as a ghost at the position a peer is live-dragging it to.
struct REMOTE_GHOST_ITEM
{
    const EDA_ITEM* item = nullptr;
    VECTOR2I        offset;

    /// When set, draws the ghost itself instead of translating @c item by @c offset: for a
    /// child (a symbol field, a sheet pin) the owner is redrawn with just that child moved.
    std::function<void( KIGFX::PAINTER*, KIGFX::GAL* )> custom;
};


/// What is drawn for one remote participant: their cursor (if on this sheet), a name
/// tag, the bounding boxes of their current selection, their in-flight route/wire
/// segments, and full ghosts of items they are dragging (when we have local copies).
/// One comment-thread pin: drawn as a numbered chip at the thread's anchor.
struct COMMENT_PIN
{
    VECTOR2I pos;
    int      count = 1;      ///< comments in the thread (root + replies)
    bool     resolved = false;
};


/// One item a proposed change touches, drawn as an outline in the colour of what would
/// happen to it (see COLLAB_PROPOSALS).
struct PROPOSAL_BOX
{
    enum KIND { ADD, MODIFY, REMOVE };

    BOX2I box;
    KIND  kind = MODIFY;
};


struct REMOTE_PEER_DRAW
{
    wxString                       clientId;   ///< whose; how COLLAB_CURSOR_ITEM::MoveCursors finds it
    VECTOR2I                       cursor;
    bool                           hasCursor = false;
    wxString                       label;

    /// What an assistant says about the place it points at (presence state.ai.note),
    /// drawn as a second chip under the name tag.  Empty for people.
    wxString                       note;
    KIGFX::COLOR4D                 color;
    std::vector<BOX2I>             selectionBoxes;
    std::vector<REMOTE_GHOST_SEG>  ghostSegs;
    std::vector<REMOTE_GHOST_ITEM> ghostItems;
};


/**
 * Draws every remote peer's cursor, name tag and selection outline at a constant
 * on-screen size, like the edit handles.  One instance per canvas draws all peers;
 * the size is taken from the view scale every frame, so this is a ViewDraw item
 * rather than a cached overlay (same approach as CONSTRAINT_BADGE_ITEM).
 */
class COLLAB_CURSOR_ITEM : public EDA_ITEM
{
public:
    COLLAB_CURSOR_ITEM();

    ~COLLAB_CURSOR_ITEM() override;

    void SetPeers( std::vector<REMOTE_PEER_DRAW>&& aPeers ) { m_peers = std::move( aPeers ); }

    /// Drop every pointer to a document item.  A ghost draws a local item at the place
    /// a peer is dragging it to, so it must go before that item can be freed: a repaint
    /// in between would draw through a dead pointer.
    void ForgetGhostItems()
    {
        for( REMOTE_PEER_DRAW& peer : m_peers )
            peer.ghostItems.clear();
    }

    /// Move the pointers only (selections, ghosts and tags stay as they are), for the
    /// prediction that runs every frame between presence messages.  @p aWhere sets the
    /// position for a client id and returns false to leave that pointer alone.
    void MoveCursors( const std::function<bool( const wxString&, VECTOR2I& )>& aWhere )
    {
        for( REMOTE_PEER_DRAW& peer : m_peers )
        {
            if( peer.hasCursor )
                aWhere( peer.clientId, peer.cursor );
        }
    }

    void SetCommentPins( std::vector<COMMENT_PIN>&& aPins ) { m_commentPins = std::move( aPins ); }

    /// The preview of a proposed change: an outline per touched item, and the tracks or
    /// wires it would add as lines.  Empty clears it.
    void SetProposalPreview( std::vector<PROPOSAL_BOX>&& aBoxes, std::vector<REMOTE_GHOST_SEG>&& aSegs )
    {
        m_proposalBoxes = std::move( aBoxes );
        m_proposalSegs = std::move( aSegs );
    }

    /**
     * Parse a server-supplied peer colour.
     *
     * COLOR4D's string constructor leaves its components uninitialized when the
     * string doesn't parse, so a malformed value would reach the GAL as
     * garbage.  Falls back to a readable default instead.
     */
    static KIGFX::COLOR4D ParsePeerColor( const wxString& aColorStr );

    const BOX2I ViewBBox() const override
    {
        BOX2I bbox;
        bbox.SetMaximum(); // Always drawn, so the per-frame screen-constant sizing stays current.
        return bbox;
    }

    std::vector<int> ViewGetLayers() const override { return { LAYER_GP_OVERLAY }; }

    void ViewDraw( int aLayer, KIGFX::VIEW* aView ) const override;

    bool HitTest( const VECTOR2I&, int = 0 ) const override { return false; }

    wxString GetClass() const override { return wxT( "COLLAB_CURSOR_ITEM" ); }

#if defined( DEBUG )
    void Show( int, std::ostream& ) const override {}
#endif

private:
    std::vector<REMOTE_PEER_DRAW> m_peers;
    std::vector<COMMENT_PIN>      m_commentPins;
    std::vector<PROPOSAL_BOX>     m_proposalBoxes;
    std::vector<REMOTE_GHOST_SEG> m_proposalSegs;
};


/**
 * Where to draw each peer's pointer between presence messages, the way Figma and
 * perfect-cursors do it (the web editor does the same, server/web/editor/peercursors.ts).
 *
 * The sender sends its pointer every frame or so, stamped with its own clock ("ts").  The
 * receiver keeps the points it has not drawn yet and walks through them at the pace they were
 * made (each step takes as long as it took the sender), a little behind the newest one.  The
 * pointer is always on the line between two places the person really was: never guessed
 * ahead, never past where they stopped.  The "little behind" adapts: it grows when the walk
 * runs out of points while the person is still moving (the network held a message) and
 * shrinks back slowly while messages come evenly.  A backlog (a burst after a stall) is walked
 * faster to catch up; when the sender says it stopped (the same place again), the walk just
 * finishes.
 */
class COLLAB_CURSOR_REPLAY
{
public:
    /// A fresh presence update for @p aId with its pointer at @p aPos, sent at the sender's
    /// clock @p aSenderTs (ms; 0 when the sender does not stamp its updates).
    void Sample( const wxString& aId, const VECTOR2I& aPos, double aSenderTs )
    {
        const double   now = ClockMs();
        const VECTOR2D pos( aPos );
        auto           it = m_tracks.find( aId );

        if( it == m_tracks.end() )
        {
            TRACK track;
            track.pos = track.from = track.drawn = pos;
            track.ts = aSenderTs;
            track.t = now;
            m_tracks.emplace( aId, track );
            return;
        }

        TRACK& tr = it->second;

        if( aSenderTs > 0.0 && tr.ts > 0.0 && aSenderTs < tr.ts )
            return;     // overtaken by a newer one

        const double gap = aSenderTs > 0.0 && tr.ts > 0.0 ? aSenderTs - tr.ts : now - tr.t;
        tr.ts = aSenderTs;
        tr.t = now;

        // The same place again is the sender saying it stopped: finish the walk.
        if( pos == tr.pos )
        {
            tr.done = true;
            return;
        }

        tr.pos = pos;

        // The walk ran dry a moment ago although the person had not stopped: the network
        // held this point.  Sit further back from now on.
        if( !tr.done && tr.steps.empty() && tr.dry > 0.0 && now - tr.dry < 200.0 )
            tr.delay = std::min( DELAY_MAX_MS, tr.delay + std::min( DELAY_STALL_STEP_MS, ( now - tr.dry ) / 2.0 ) );

        tr.dry = 0.0;

        // Moving again after a rest: the first step takes the delay, so the next point is
        // likely here before the walk reaches this one.
        const bool   resting = tr.done || tr.steps.empty();
        const double d = resting ? tr.delay
                                 : std::clamp( gap > 0.0 ? gap : STEP_DEFAULT_MS, 1.0, STEP_MAX_MS );

        tr.done = false;
        tr.steps.push_back( { pos, d } );

        while( tr.steps.size() > 120 )
        {
            tr.from = tr.steps.front().pos;
            tr.steps.pop_front();
            tr.p = 0.0;
        }
    }

    /// Forget everyone not in @p aIds.
    void Retain( const std::set<wxString>& aIds )
    {
        for( auto it = m_tracks.begin(); it != m_tracks.end(); )
            it = aIds.count( it->first ) ? std::next( it ) : m_tracks.erase( it );
    }

    /// Move every drawn pointer one frame on.  Returns whether any is still moving (keep
    /// calling it every frame while it does).
    bool Advance()
    {
        const double now = ClockMs();
        const double dt = m_lastFrame > 0.0 ? std::min( 50.0, now - m_lastFrame ) : 0.0;
        bool         moving = false;

        m_lastFrame = now;

        for( auto& [id, tr] : m_tracks )
        {
            if( !tr.steps.empty() )
            {
                // how much walk is still ahead, against how far behind it should be
                double ahead = -tr.p;

                for( const STEP& st : tr.steps )
                    ahead += st.d;

                const double want = 1.0 + ( ahead - tr.delay ) / 40.0;
                const double rate = std::clamp( want, tr.done ? 1.0 : RATE_MIN, RATE_MAX );
                double       adv = dt * rate;

                while( adv > 0.0 && !tr.steps.empty() )
                {
                    const STEP&  st = tr.steps.front();
                    const double left = st.d - tr.p;

                    if( adv >= left )
                    {
                        adv -= left;
                        tr.from = st.pos;
                        tr.steps.pop_front();
                        tr.p = 0.0;
                    }
                    else
                    {
                        tr.p += adv;
                        adv = 0.0;
                    }
                }

                // ran out while the person may still be moving: either they stopped (their
                // stop message follows) or the network is holding the next point
                if( tr.steps.empty() && !tr.done )
                    tr.dry = now;
            }

            if( dt > 0.0 )
                tr.delay = std::max( DELAY_MIN_MS, tr.delay - DELAY_DECAY_MS_PER_S * dt / 1000.0 );

            if( !tr.steps.empty() )
            {
                const STEP&  st = tr.steps.front();
                const double k = st.d > 0.0 ? tr.p / st.d : 1.0;
                tr.drawn = tr.from + ( st.pos - tr.from ) * k;
                moving = true;
            }
            else
            {
                tr.drawn = tr.from;
            }
        }

        if( !moving )
            m_lastFrame = 0.0;

        return moving;
    }

    /// Where to draw @p aId's pointer now; false for someone not seen.
    bool Where( const wxString& aId, VECTOR2I& aPos ) const
    {
        auto it = m_tracks.find( aId );

        if( it == m_tracks.end() )
            return false;

        aPos = VECTOR2I( KiROUND( it->second.drawn.x ), KiROUND( it->second.drawn.y ) );
        return true;
    }

    /// The clock a sender stamps its presence with ("ts"), ms.
    static double ClockMs()
    {
        using namespace std::chrono;
        return duration<double, std::milli>( steady_clock::now().time_since_epoch() ).count();
    }

private:
    struct STEP
    {
        VECTOR2D pos;           ///< where this step ends, IU
        double   d = 0.0;       ///< how long it takes, ms
    };

    struct TRACK
    {
        VECTOR2D         pos;           ///< newest point received, IU
        VECTOR2D         from;          ///< the point the walk left, IU
        VECTOR2D         drawn;         ///< what is drawn, IU
        std::deque<STEP> steps;         ///< the points still ahead
        double           p = 0.0;       ///< ms into the first step
        double           ts = 0.0;      ///< sender stamp of the newest point
        double           t = 0.0;       ///< when it came, ms
        double           delay = DELAY_START_MS;  ///< how far behind the newest point, ms
        double           dry = 0.0;     ///< when the walk last ran out mid-motion, ms
        bool             done = true;   ///< the sender said it stopped
    };

    static constexpr double DELAY_START_MS = 24.0, DELAY_MIN_MS = 16.0, DELAY_MAX_MS = 40.0;
    static constexpr double DELAY_STALL_STEP_MS = 3.0, DELAY_DECAY_MS_PER_S = 8.0;
    static constexpr double STEP_MAX_MS = 60.0, STEP_DEFAULT_MS = 15.0;
    static constexpr double RATE_MAX = 4.0, RATE_MIN = 0.8;

    std::map<wxString, TRACK> m_tracks;
    double                    m_lastFrame = 0.0;
};
