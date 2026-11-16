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
 * Where to draw each peer's pointer: where their hand most likely is now, not where it was
 * when the update left them (the web editor does the same, server/web/editor/peercursors.ts).
 *
 * An update is already one trip through the server old when it arrives (half the sender's
 * round trip plus half ours, both measured with pings and the sender's sent along with its
 * pointer), and the next one is still a message interval away.  The pointer is carried on
 * along its velocity by that much.  A sender that stops sends its place once more, which
 * zeroes the velocity, so a guess past the stopping point is taken back within about one
 * trip; with no news for longer than the guess covers, it eases back to the last place seen.
 * Between those, the drawn position closes on the target quickly but not in one jump, so a
 * correction never shows as a hop.
 */
class COLLAB_CURSOR_PREDICTOR
{
public:
    /// A fresh presence update for @p aId with its pointer at @p aPos.  @p aLeadMs is how
    /// old the update was on arrival.
    void Sample( const wxString& aId, const VECTOR2I& aPos, double aLeadMs )
    {
        const double now = NowMs();
        auto         it = m_tracks.find( aId );

        if( it == m_tracks.end() )
        {
            TRACK track;
            track.pos = VECTOR2D( aPos );
            track.drawn = track.pos;
            track.t = now;
            track.lead = std::min( aLeadMs, LEAD_MAX_MS );
            m_tracks.emplace( aId, track );
            return;
        }

        TRACK& tr = it->second;
        tr.lead = std::min( aLeadMs, LEAD_MAX_MS );
        const VECTOR2D pos( aPos );

        // The same place again is the sender saying it stopped.
        if( pos == tr.pos )
        {
            tr.vel = VECTOR2D( 0, 0 );
            tr.t = now;
            return;
        }

        const double dt = now - tr.t;

        // A sample after a long gap is a fresh start, not a speed; otherwise a little
        // smoothing, because the lead multiplies any jitter in the velocity.
        if( dt > 4.0 && dt < 150.0 )
        {
            const VECTOR2D v = ( pos - tr.pos ) / dt;
            const bool     fresh = tr.vel.x == 0.0 && tr.vel.y == 0.0;
            tr.vel = fresh ? v : tr.vel * 0.35 + v * 0.65;
            tr.every = tr.every * 0.8 + std::min( dt, 100.0 ) * 0.2;
        }
        else if( dt >= 150.0 )
        {
            tr.vel = VECTOR2D( 0, 0 );
        }

        tr.pos = pos;
        tr.t = now;
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
        const double now = NowMs();
        const double dt = m_lastFrame > 0.0 ? std::min( 50.0, now - m_lastFrame ) : 16.0;
        const double a = 1.0 - std::exp( -dt / EASE_MS );
        bool         moving = false;

        m_lastFrame = now;

        for( auto& [id, tr] : m_tracks )
        {
            const VECTOR2D target = targetOf( tr, now );
            const VECTOR2D err = target - tr.drawn;

            // Internal units: well under a pixel at any zoom anyone works at.
            if( std::abs( err.x ) < 100 && std::abs( err.y ) < 100 )
            {
                tr.drawn = target;
            }
            else
            {
                tr.drawn += err * a;
                moving = true;
            }

            if( ( tr.vel.x != 0.0 || tr.vel.y != 0.0 )
                && now - tr.t < 2.0 * horizon( tr ) + tr.lead )
            {
                moving = true;
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

    /// How old an update is on arrival, given the sender's round trip (0 when it does not
    /// say: assume it is as far as we are) and ours.
    static double LeadMs( double aSenderRtt, double aOwnRtt )
    {
        return std::min( LEAD_MAX_MS, ( aSenderRtt > 0.0 ? aSenderRtt : aOwnRtt ) / 2.0
                                              + aOwnRtt / 2.0 + FRAME_MS );
    }

private:
    struct TRACK
    {
        VECTOR2D pos;           ///< last sample, IU
        VECTOR2D vel;           ///< IU per ms
        VECTOR2D drawn;         ///< what is drawn, IU
        double   t = 0.0;       ///< when the last sample came, ms
        double   every = 16.0;  ///< usual time between samples, ms
        double   lead = 0.0;    ///< how old a sample is on arrival, ms
    };

    static constexpr double CARRY_MAX_MS = 60.0;  ///< the longest a pointer is carried on
    static constexpr double LEAD_MAX_MS = 90.0;   ///< a far-away server is not guessed across
    static constexpr double FRAME_MS = 4.0;       ///< arrival to screen
    /// Prediction is off: in use it read as jitter, every late or early update showing as a
    /// lurch.  Without it a pointer glides to each update as it arrives, over about one frame.
    /// Set to true to bring it back (the web editor's switch is in peercursors.ts).
    static constexpr bool   PREDICT = false;
    static constexpr double EASE_MS = PREDICT ? 7.0 : 14.0; ///< how fast the drawn pointer closes in

    static double NowMs()
    {
        using namespace std::chrono;
        return duration<double, std::milli>( steady_clock::now().time_since_epoch() ).count();
    }

    static double horizon( const TRACK& aTrack )
    {
        return std::min( CARRY_MAX_MS, aTrack.every * 1.2 );
    }

    /// Ahead of the last sample by its age on arrival plus the time since, until about the
    /// next sample is due; past that, eased back to the last sample, so a pointer whose stop
    /// message got lost still ends exactly where it was last seen.
    static VECTOR2D targetOf( const TRACK& aTrack, double aNow )
    {
        if( !PREDICT )
            return aTrack.pos;

        const double age = aNow - aTrack.t, carry = horizon( aTrack );
        const double k = age <= carry ? aTrack.lead + age
                                      : std::max( 0.0, aTrack.lead + carry - 2.0 * ( age - carry ) );
        return aTrack.pos + aTrack.vel * k;
    }

    std::map<wxString, TRACK> m_tracks;
    double                    m_lastFrame = 0.0;
};
